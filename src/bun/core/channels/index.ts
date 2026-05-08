/**
 * Channels composition root.
 *
 * Detour exposes 1:N messaging channels (Discord, Telegram, iMessage, ...) by
 * loading the matching elizaOS plugin into the AgentRuntime when the user has
 * configured credentials. This module owns:
 *
 *   - the channel registry (name → vault keys + plugin module loader)
 *   - configuration probing (`isConfigured(channel)`)
 *   - the snapshot the UI uses (`/api/channels/*`)
 *   - the plugin list contributed at runtime build time
 *
 * The vault is the source of truth for credentials. We only `await import()`
 * the plugin module when the channel is configured — no point loading
 * Discord's discord.js into memory if the user never set DISCORD_API_TOKEN.
 */

import { logger, type IAgentRuntime, type Plugin } from "@elizaos/core";
import type { VaultService } from "../vault";

// Discord bot tokens have a strict format: <id_base64>.<timestamp>.<hmac>,
// 70+ chars, two dots. Telegram bot tokens: <bot_id>:<35-char-secret>,
// always one colon, ~46 chars total. Use these to flag obviously-wrong
// credentials BEFORE the plugin tries to log in (silent failure otherwise).
function looksLikeDiscordBotToken(value: string): boolean {
	return value.length >= 50 && value.split(".").length === 3;
}
function looksLikeTelegramBotToken(value: string): boolean {
	if (!value.includes(":")) return false;
	const [id, secret] = value.split(":");
	return /^\d{6,12}$/.test(id ?? "") && (secret?.length ?? 0) >= 30;
}

function invalidChannelCredential(id: ChannelId, key: string, value: string): ChannelLiveSnapshot | null {
	if (id === "discord" && key === "DISCORD_API_TOKEN" && !looksLikeDiscordBotToken(value)) {
		return {
			liveStatus: "invalid-token",
			liveDetail: `${key} doesn't look like a Discord bot token (expected ~70 chars with two dots; got ${value.length} chars, ${value.split(".").length - 1} dots).`,
		};
	}
	if (id === "telegram" && key === "TELEGRAM_BOT_TOKEN" && !looksLikeTelegramBotToken(value)) {
		return {
			liveStatus: "invalid-token",
			liveDetail: `${key} doesn't look like a Telegram bot token (expected <id>:<35-char secret>).`,
		};
	}
	return null;
}

function settingField<K extends "autoReply" | "respondOnlyToMentions">(key: K, value: boolean | undefined): Pick<ChannelStatus, K> | {} {
	return value === undefined ? {} : { [key]: value } as Pick<ChannelStatus, K>;
}

type ChannelServiceRecord = Record<string, unknown>;
type DiscordClientProbe = {
	readyAt?: Date | null;
	user?: { tag?: string; username?: string } | null;
	ws?: { status?: number };
	guilds?: { cache?: { size?: number } };
};
type TelegramBotProbe = { botInfo?: { username?: string; id?: number } };
type GitHubServiceProbe = { getOctokit?: (as: "user" | "agent") => object | null };

function serviceKeys(svc: ChannelServiceRecord): string[] {
	return Object.keys(svc).filter((k) => !k.startsWith("_")).slice(0, 40);
}

function serviceClassName(svc: ChannelServiceRecord): string {
	return (svc.constructor as { name?: string } | undefined)?.name ?? "?";
}

function resolveChannelService(runtime: IAgentRuntime, id: ChannelId): ChannelServiceRecord | undefined {
	const r = runtime as unknown as {
		getService?: (t: string) => unknown;
		getServicesByType?: (t: string) => unknown[];
	};
	return (r.getService?.(id) ?? r.getServicesByType?.(id)?.[0]) as ChannelServiceRecord | undefined;
}

function probeChannelLive(runtime: IAgentRuntime, id: ChannelId): { status: ChannelLiveStatus; detail?: string } {
	const svc = resolveChannelService(runtime, id);
	if (!svc) return { status: "loaded", detail: "service not registered yet" };
	switch (id) {
		case "discord":
			return probeDiscordLive(svc);
		case "telegram":
			return probeTelegramLive(svc);
		case "github":
			return probeGithubLive(svc);
		case "imessage":
			return probeImessageLive(svc);
	}
	return { status: "loaded" };
}

function probeDiscordLive(svc: ChannelServiceRecord): { status: ChannelLiveStatus; detail?: string } {
	const client = svc.client as DiscordClientProbe | null;
	if (!client) return probeMissingDiscordClient(svc);
	if (client.readyAt) return probeReadyDiscordClient(client);
	return { status: "connecting", detail: `Logging in (ws.status=${client.ws?.status ?? "?"})` };
}

function probeMissingDiscordClient(svc: ChannelServiceRecord): { status: ChannelLiveStatus; detail: string } {
	const loginFailed = (svc as { _loginFailed?: boolean })._loginFailed === true;
	logger.info(
		{
			src: "channels:probe",
			constructor: serviceClassName(svc),
			loginFailed,
			hasReadyPromise: (svc as { clientReadyPromise?: unknown }).clientReadyPromise !== undefined,
			keys: serviceKeys(svc),
		},
		"discord svc.client is null — service did not finish login",
	);
	return {
		status: loginFailed ? "error" : "connecting",
		detail: loginFailed
			? "Discord login failed — check DISCORD_API_TOKEN (regenerate in Developer Portal)"
			: "Discord client not yet created",
	};
}

function probeReadyDiscordClient(client: DiscordClientProbe): { status: ChannelLiveStatus; detail: string } {
	const tag = client.user?.tag ?? client.user?.username ?? "bot";
	const guildCount = client.guilds?.cache?.size ?? 0;
	if (guildCount === 0) {
		return {
			status: "error",
			detail: `${tag} is online but in 0 servers — invite the bot via https://discord.com/developers/applications/<APP_ID>/oauth2/url-generator (scope: bot, perms: View Channels + Read Message History + Send Messages).`,
		};
	}
	return {
		status: "online",
		detail: `${tag} is online in ${guildCount} server${guildCount === 1 ? "" : "s"}`,
	};
}

function probeTelegramLive(svc: ChannelServiceRecord): { status: ChannelLiveStatus; detail?: string } {
	const bot = svc.bot as TelegramBotProbe | null;
	if (!bot) return probeMissingTelegramBot(svc);
	if (bot.botInfo?.id) return { status: "online", detail: `@${bot.botInfo.username} is online` };
	return { status: "connecting", detail: "Telegraf handshake in progress" };
}

function probeMissingTelegramBot(svc: ChannelServiceRecord): { status: ChannelLiveStatus; detail: string } {
	logger.info(
		{ src: "channels:probe", constructor: serviceClassName(svc), keys: serviceKeys(svc) },
		"telegram svc.bot is null — Telegraf not yet constructed",
	);
	return { status: "connecting", detail: "Telegraf bot not yet created" };
}

function probeGithubLive(svc: ChannelServiceRecord): { status: ChannelLiveStatus; detail?: string } {
	const getOctokit = (svc as GitHubServiceProbe).getOctokit;
	if (typeof getOctokit !== "function") return { status: "loaded", detail: "GitHub service loaded; client probe unavailable" };
	const userClient = getOctokit.call(svc, "user");
	const agentClient = getOctokit.call(svc, "agent");
	if (!userClient && !agentClient) return { status: "error", detail: "GitHub plugin loaded but no PAT is available" };
	const modes = [
		...(userClient ? ["user"] : []),
		...(agentClient ? ["agent"] : []),
	].join("+");
	return { status: "online", detail: `GitHub client ready (${modes})` };
}

function probeImessageLive(svc: ChannelServiceRecord): { status: ChannelLiveStatus; detail?: string } {
	const getStatus = (svc as { getStatus?: () => unknown }).getStatus;
	if (typeof getStatus !== "function") return { status: "loaded", detail: "iMessage service loaded; status unavailable" };
	const status = getStatus.call(svc);
	if (!status || typeof status !== "object") return { status: "loaded", detail: "iMessage service loaded; status unavailable" };
	const record = status as Record<string, unknown>;
	if (record.chatDbAvailable === true) return { status: "online", detail: "chat.db readable; inbound polling ready" };
	if (record.connected === true) return imessageSendOnlyStatus(record);
	const reason = typeof record.reason === "string" ? record.reason : "service not connected";
	return { status: "connecting", detail: reason };
}

function imessageSendOnlyStatus(record: Record<string, unknown>): { status: ChannelLiveStatus; detail: string } {
	const reason = typeof record.reason === "string" ? record.reason : "Full Disk Access required for receive";
	return { status: "loaded", detail: `Send-only mode (${reason})` };
}

// Channel plugins are loaded via `await import("...")` with hardcoded
// strings — Bun's bundler scans those literals and packs the plugin code
// (and most JS deps) into the .app. We DON'T use static `import` because
// some channel plugins (Discord especially) pull in native `.node`
// bindings (e.g. @discordjs/voice's DAVESession) that can't be bundled
// into a single JS file — a static import would throw at module-eval time
// and crash the whole app on startup. Wrapped in try/catch so a missing
// native dep degrades to "channel unavailable" instead of "agent dead".

function pickPlugin(mod: unknown, name: string): Plugin | null {
	if (!mod) return null;
	const m = mod as { default?: unknown; [k: string]: unknown };
	const candidate =
		(m.default as Plugin | undefined) ??
		(m[`${name}Plugin`] as Plugin | undefined) ??
		(m[name] as Plugin | undefined);
	return candidate ?? null;
}

export type ChannelId = "discord" | "telegram" | "github" | "imessage";

export interface ChannelDefinition {
	id: ChannelId;
	label: string;
	description: string;
	requiredVaultKeys: string[];
	optionalVaultKeys: string[];
	platform: "any" | "macos";
	pluginPackage: string;
	loadPlugin: () => Promise<Plugin | null>;
}

/** Lazy + safe loaders. Each await import() string is hardcoded so the
 *  bundler picks up the dependency, but evaluation only happens when the
 *  channel is actually being enabled — and we catch any native-dep failure.
 *
 *  The @ts-expect-error suppressions exist because the upstream eliza
 *  channel plugins (plugin-telegram especially) have a tsup DTS build
 *  step that fails on TS6.0 baseUrl deprecation in their tsconfig. We
 *  ship them at runtime fine via Bun's source resolver, and runtime
 *  failure is already handled by the try/catch — losing the type
 *  surface here is the right trade.
 */
async function loadDiscord(): Promise<Plugin | null> {
	try {
		// @ts-ignore eliza dynamic plugin — types unavailable when dist isn't built
		const mod = await import("@elizaos/plugin-discord");
		return pickPlugin(mod, "discord");
	} catch (err) {
		console.warn("[channels] discord plugin load failed:", err instanceof Error ? err.message : err);
		return null;
	}
}
async function loadTelegram(): Promise<Plugin | null> {
	try {
		// @ts-ignore eliza dynamic plugin — types unavailable when dist isn't built
		const mod = await import("@elizaos/plugin-telegram");
		return pickPlugin(mod, "telegram");
	} catch (err) {
		console.warn("[channels] telegram plugin load failed:", err instanceof Error ? err.message : err);
		return null;
	}
}
async function loadGithub(): Promise<Plugin | null> {
	try {
		// @ts-ignore eliza dynamic plugin — types unavailable when dist isn't built
		const mod = await import("@elizaos/plugin-github");
		return pickPlugin(mod, "github");
	} catch (err) {
		logger.warn(
			{ src: "channels", error: err instanceof Error ? err.message : String(err) },
			"github plugin load failed",
		);
		return null;
	}
}
async function loadImessage(): Promise<Plugin | null> {
	if (process.platform !== "darwin") return null;
	try {
		// @ts-ignore eliza dynamic plugin — types unavailable when dist isn't built
		const mod = await import("@elizaos/plugin-imessage");
		return pickPlugin(mod, "imessage");
	} catch (err) {
		console.warn("[channels] imessage plugin load failed:", err instanceof Error ? err.message : err);
		return null;
	}
}

const CHANNEL_DEFINITIONS: ChannelDefinition[] = [
	{
		id: "discord",
		label: "Discord",
		description: "Connect a Discord bot. Required: DISCORD_API_TOKEN. Optional: DISCORD_APPLICATION_ID.",
		requiredVaultKeys: ["DISCORD_API_TOKEN"],
		optionalVaultKeys: ["DISCORD_APPLICATION_ID", "DISCORD_AUTO_REPLY", "DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS", "DISCORD_CATCH_UP_ENABLED"],
		platform: "any",
		pluginPackage: "@elizaos/plugin-discord",
		loadPlugin: loadDiscord,
	},
	{
		id: "telegram",
		label: "Telegram",
		description: "Connect a Telegram bot. Required: TELEGRAM_BOT_TOKEN.",
		requiredVaultKeys: ["TELEGRAM_BOT_TOKEN"],
		optionalVaultKeys: ["TELEGRAM_AUTO_REPLY"],
		platform: "any",
		pluginPackage: "@elizaos/plugin-telegram",
		loadPlugin: loadTelegram,
	},
	{
		id: "github",
		label: "GitHub",
		description: "Connect GitHub for PRs, issues, review actions, and notification triage. Required: GITHUB_USER_PAT and GITHUB_AGENT_PAT.",
		requiredVaultKeys: ["GITHUB_USER_PAT", "GITHUB_AGENT_PAT"],
		optionalVaultKeys: ["GITHUB_TOKEN"],
		platform: "any",
		pluginPackage: "@elizaos/plugin-github",
		loadPlugin: loadGithub,
	},
	{
		id: "imessage",
		label: "iMessage",
		description: "Bridge macOS Messages. Requires Full Disk Access for ~/Library/Messages/chat.db.",
		// iMessage has no API token, but we use IMESSAGE_ENABLED as the
		// explicit opt-in signal — listing it here means `configured`
		// reflects "user has enabled it" not just "platform supports it".
		requiredVaultKeys: ["IMESSAGE_ENABLED"],
		optionalVaultKeys: [],
		platform: "macos",
		pluginPackage: "@elizaos/plugin-imessage",
		loadPlugin: loadImessage,
	},
];

export type ChannelLiveStatus =
	| "off"            // not configured / not loaded
	| "loaded"         // module in memory but no live connection probed
	| "connecting"     // service started, gateway handshake in progress
	| "online"         // gateway fully connected, bot user online
	| "invalid-token"  // credential present but format is clearly wrong
	| "error";         // service started but reports a fatal error

export interface ChannelStatus {
	id: ChannelId;
	label: string;
	description: string;
	platform: "any" | "macos";
	requiredVaultKeys: string[];
	optionalVaultKeys: string[];
	pluginPackage: string;
	configured: boolean;
	missingKeys: string[];
	platformAvailable: boolean;
	pluginLoaded: boolean;
	liveStatus: ChannelLiveStatus;
	liveDetail?: string;
	autoReply?: boolean;
	respondOnlyToMentions?: boolean;
}

export interface ChannelsSnapshot {
	channels: ChannelStatus[];
}

type ChannelLiveSnapshot = { liveStatus: ChannelLiveStatus; liveDetail?: string };

export class ChannelsService {
	constructor(private readonly vault: VaultService) {}

	definitions(): ChannelDefinition[] {
		return CHANNEL_DEFINITIONS;
	}

	private async hasAllKeys(keys: string[]): Promise<{ ok: boolean; missing: string[] }> {
		if (keys.length === 0) return { ok: true, missing: [] };
		const v = await this.vault.vault();
		const missing: string[] = [];
		for (const k of keys) {
			if (!(await v.has(k))) missing.push(k);
		}
		return { ok: missing.length === 0, missing };
	}

	private async hasRequiredCredentials(def: ChannelDefinition): Promise<{ ok: boolean; missing: string[] }> {
		if (def.id !== "github") return this.hasAllKeys(def.requiredVaultKeys);
		const v = await this.vault.vault();
		if (await v.has("GITHUB_TOKEN")) return { ok: true, missing: [] };
		return this.hasAllKeys(def.requiredVaultKeys);
	}

	private boolSetting(runtime: IAgentRuntime | null, key: string): boolean | undefined {
		const value = runtime?.getSetting(key);
		if (value === true || value === false) return value;
		if (typeof value === "string") {
			const normalized = value.trim().toLowerCase();
			if (["true", "1", "yes", "on"].includes(normalized)) return true;
			if (["false", "0", "no", "off"].includes(normalized)) return false;
		}
		return undefined;
	}

	async snapshot(loadedPlugins: string[] = [], runtime: IAgentRuntime | null = null): Promise<ChannelsSnapshot> {
		const loadedSet = new Set(loadedPlugins.map((s) => s.toLowerCase()));
		const channels = await Promise.all(CHANNEL_DEFINITIONS.map((def) => this.channelStatus(def, loadedSet, runtime)));
		return { channels };
	}

	private async channelStatus(def: ChannelDefinition, loadedSet: Set<string>, runtime: IAgentRuntime | null): Promise<ChannelStatus> {
		const platformAvailable = this.platformAvailable(def);
		const { ok, missing } = await this.hasRequiredCredentials(def);
		const pluginLoaded = this.pluginLoaded(def, loadedSet);
		const live = await this.channelLive(def, ok, pluginLoaded, runtime);
		return {
			id: def.id,
			label: def.label,
			description: def.description,
			platform: def.platform,
			requiredVaultKeys: def.requiredVaultKeys,
			optionalVaultKeys: def.optionalVaultKeys,
			pluginPackage: def.pluginPackage,
			configured: ok && platformAvailable,
			missingKeys: missing,
			platformAvailable,
			pluginLoaded,
			liveStatus: live.liveStatus,
			...(live.liveDetail ? { liveDetail: live.liveDetail } : {}),
			...this.channelRuntimeSettings(def, runtime),
		};
	}

	private platformAvailable(def: ChannelDefinition): boolean {
		return def.platform === "any" || (def.platform === "macos" && process.platform === "darwin");
	}

	private pluginLoaded(def: ChannelDefinition, loadedSet: Set<string>): boolean {
		return loadedSet.has(def.id)
			|| loadedSet.has(def.pluginPackage.toLowerCase())
			|| loadedSet.has(def.pluginPackage.replace(/^@elizaos\//, "").toLowerCase());
	}

	private async channelLive(
		def: ChannelDefinition,
		keysOk: boolean,
		pluginLoaded: boolean,
		runtime: IAgentRuntime | null,
	): Promise<ChannelLiveSnapshot> {
		const invalid = keysOk ? await this.invalidCredentialStatus(def) : null;
		if (invalid) return invalid;
		if (pluginLoaded && runtime) {
			const probed = probeChannelLive(runtime, def.id);
			return { liveStatus: probed.status, ...(probed.detail ? { liveDetail: probed.detail } : {}) };
		}
		return pluginLoaded
			? { liveStatus: "loaded", liveDetail: "plugin loaded but runtime unavailable" }
			: { liveStatus: "off" };
	}

	private async invalidCredentialStatus(def: ChannelDefinition): Promise<ChannelLiveSnapshot | null> {
		const v = await this.vault.vault();
		for (const key of def.requiredVaultKeys) {
			const value = await v.get(key).catch(() => "");
			const invalid = invalidChannelCredential(def.id, key, value);
			if (invalid) return invalid;
		}
		return null;
	}

	private channelRuntimeSettings(def: ChannelDefinition, runtime: IAgentRuntime | null): Partial<ChannelStatus> {
		if (def.id === "discord") {
			return {
				...settingField("autoReply", this.boolSetting(runtime, "DISCORD_AUTO_REPLY")),
				...settingField("respondOnlyToMentions", this.boolSetting(runtime, "DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS")),
			};
		}
		if (def.id === "telegram") return settingField("autoReply", this.boolSetting(runtime, "TELEGRAM_AUTO_REPLY"));
		return {};
	}

	/** Read every required + optional vault credential for a channel.
	 *  Returns a flat record. We push these into BOTH process.env (so any
	 *  plugin code that reads `process.env` directly still works) AND into
	 *  the AgentRuntime constructor's `settings` map (which is what
	 *  `runtime.getSetting()` actually checks — env is not read by default
	 *  in eliza). */
	private async readCredentials(def: ChannelDefinition): Promise<Record<string, string>> {
		const v = await this.vault.vault();
		const out: Record<string, string> = {};
		for (const key of [...def.requiredVaultKeys, ...def.optionalVaultKeys]) {
			if (await v.has(key)) {
				try {
					out[key] = await v.get(key);
				} catch (err) {
					console.warn(`[channels] failed to read ${key} from vault:`, err instanceof Error ? err.message : err);
				}
			}
		}
		return this.normalizeCredentials(def, out);
	}

	private normalizeCredentials(def: ChannelDefinition, credentials: Record<string, string>): Record<string, string> {
		if (def.id !== "github") return credentials;
		const out = { ...credentials };
		const token = out.GITHUB_TOKEN || out.GITHUB_USER_PAT || out.GITHUB_AGENT_PAT;
		if (!token) return out;
		if (!out.GITHUB_USER_PAT) out.GITHUB_USER_PAT = token;
		if (!out.GITHUB_AGENT_PAT) out.GITHUB_AGENT_PAT = token;
		return out;
	}

	/** Resolve the plugins that should be loaded + the credentials that
	 *  should be exposed to the AgentRuntime via opts.settings. Caller wires
	 *  `settings` into `new AgentRuntime({ ..., settings })` so plugins'
	 *  `runtime.getSetting()` calls can find their tokens. */
	async resolvePlugins(): Promise<{ plugins: Plugin[]; settings: Record<string, string> }> {
		const plugins: Plugin[] = [];
		const settings: Record<string, string> = {};
		for (const def of CHANNEL_DEFINITIONS) {
			const platformAvailable = def.platform === "any" || (def.platform === "macos" && process.platform === "darwin");
			if (!platformAvailable) continue;
			const { ok } = await this.hasRequiredCredentials(def);
			if (!ok && def.requiredVaultKeys.length > 0) continue;
			// IMESSAGE_ENABLED is now in requiredVaultKeys, so the hasAllKeys
			// check above already gates iMessage on the user enabling it.
			const creds = await this.readCredentials(def);
			// Belt-and-suspenders: also push to process.env for any code path
			// that reads it directly (some plugins do).
			for (const [k, val] of Object.entries(creds)) {
				process.env[k] = val;
				settings[k] = val;
			}
			if (Object.keys(creds).length > 0) {
				console.log(`[channels] ${def.id} creds wired: ${Object.keys(creds).join(", ")}`);
			}
			const plugin = await def.loadPlugin();
			if (plugin) plugins.push(plugin);
		}
		return { plugins, settings };
	}

	async setCredential(key: string, value: string): Promise<void> {
		const v = await this.vault.vault();
		await v.set(key, value);
	}

	async clearCredential(key: string): Promise<void> {
		const v = await this.vault.vault();
		await v.remove(key);
	}
}
