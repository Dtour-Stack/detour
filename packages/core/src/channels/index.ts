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

/**
 * Probe a channel's actual gateway/connection state via its registered
 * service. Different plugins expose connection state differently:
 *   - discord:  service.client (DiscordJsClient | null) + client.readyAt + client.user
 *   - telegram: service.bot (Telegraf | null) + service.botInfo + bot.botInfo.id
 *   - imessage: service has no gateway (uses local sqlite) — "online" if Full Disk Access granted
 */
function probeChannelLive(runtime: IAgentRuntime, id: ChannelId): { status: ChannelLiveStatus; detail?: string } {
	const r = runtime as unknown as {
		getService?: (t: string) => unknown;
		getServicesByType?: (t: string) => unknown[];
	};
	const svc = (r.getService?.(id) ?? r.getServicesByType?.(id)?.[0]) as Record<string, unknown> | undefined;
	if (!svc) return { status: "loaded", detail: "service not registered yet" };

	if (id === "discord") {
		const client = svc.client as {
			readyAt?: Date | null;
			user?: { tag?: string; username?: string } | null;
			ws?: { status?: number };
			guilds?: { cache?: { size?: number } };
		} | null;
		if (!client) {
			// Diagnostic: surface what fields ARE on the service so we can see
			// whether the service is a stale class reference, the client lives
			// under a renamed property, or a different sub-service is being
			// returned. Routed via elizaOS logger so it shows in the activity
			// feed (our log capture only listens to addLogListener — not raw
			// console.log).
			const keys = Object.keys(svc).filter((k) => !k.startsWith("_")).slice(0, 40);
			const cls = (svc.constructor as { name?: string } | undefined)?.name ?? "?";
			const loginFailed = (svc as { _loginFailed?: boolean })._loginFailed === true;
			const hasReadyPromise = (svc as { clientReadyPromise?: unknown }).clientReadyPromise !== undefined;
			logger.info(
				{
					src: "channels:probe",
					constructor: cls,
					loginFailed,
					hasReadyPromise,
					keys,
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
		if (client.readyAt) {
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
		return { status: "connecting", detail: `Logging in (ws.status=${client.ws?.status ?? "?"})` };
	}

	if (id === "telegram") {
		const bot = svc.bot as { botInfo?: { username?: string; id?: number } } | null;
		if (!bot) {
			const keys = Object.keys(svc).filter((k) => !k.startsWith("_")).slice(0, 40);
			const cls = (svc.constructor as { name?: string } | undefined)?.name ?? "?";
			logger.info(
				{ src: "channels:probe", constructor: cls, keys },
				"telegram svc.bot is null — Telegraf not yet constructed",
			);
			return { status: "connecting", detail: "Telegraf bot not yet created" };
		}
		if (bot.botInfo?.id) {
			return { status: "online", detail: `@${bot.botInfo.username} is online` };
		}
		return { status: "connecting", detail: "Telegraf handshake in progress" };
	}

	if (id === "imessage") {
		// imessage uses local SQLite — "online" once the service has read chat.db.
		// service.chatDbReady or similar; fall back to "loaded".
		const ready = svc.chatDbReady ?? svc.ready ?? svc.started;
		if (ready === true) return { status: "online", detail: "chat.db readable" };
		return { status: "loaded", detail: "Send-only mode (Full Disk Access required for receive)" };
	}

	return { status: "loaded" };
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

export type ChannelId = "discord" | "telegram" | "imessage";

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
 *  channel is actually being enabled — and we catch any native-dep failure. */
async function loadDiscord(): Promise<Plugin | null> {
	try {
		const mod = await import("@elizaos/plugin-discord");
		return pickPlugin(mod, "discord");
	} catch (err) {
		console.warn("[channels] discord plugin load failed:", err instanceof Error ? err.message : err);
		return null;
	}
}
async function loadTelegram(): Promise<Plugin | null> {
	try {
		const mod = await import("@elizaos/plugin-telegram");
		return pickPlugin(mod, "telegram");
	} catch (err) {
		console.warn("[channels] telegram plugin load failed:", err instanceof Error ? err.message : err);
		return null;
	}
}
async function loadImessage(): Promise<Plugin | null> {
	if (process.platform !== "darwin") return null;
	try {
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
		optionalVaultKeys: ["DISCORD_APPLICATION_ID"],
		platform: "any",
		pluginPackage: "@elizaos/plugin-discord",
		loadPlugin: loadDiscord,
	},
	{
		id: "telegram",
		label: "Telegram",
		description: "Connect a Telegram bot. Required: TELEGRAM_BOT_TOKEN.",
		requiredVaultKeys: ["TELEGRAM_BOT_TOKEN"],
		optionalVaultKeys: [],
		platform: "any",
		pluginPackage: "@elizaos/plugin-telegram",
		loadPlugin: loadTelegram,
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
}

export interface ChannelsSnapshot {
	channels: ChannelStatus[];
}

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

	async snapshot(loadedPlugins: string[] = [], runtime: IAgentRuntime | null = null): Promise<ChannelsSnapshot> {
		const out: ChannelStatus[] = [];
		const loadedSet = new Set(loadedPlugins.map((s) => s.toLowerCase()));
		for (const def of CHANNEL_DEFINITIONS) {
			const platformAvailable = def.platform === "any" || (def.platform === "macos" && process.platform === "darwin");
			const { ok, missing } = await this.hasAllKeys(def.requiredVaultKeys);
			const pluginLoaded =
				loadedSet.has(def.id) ||
				loadedSet.has(def.pluginPackage.toLowerCase()) ||
				loadedSet.has(def.pluginPackage.replace(/^@elizaos\//, "").toLowerCase());

			// Token format pre-check — surfaces obviously wrong credentials
			// before the plugin silently fails to log in.
			let liveStatus: ChannelLiveStatus = "off";
			let liveDetail: string | undefined;
			if (ok && def.requiredVaultKeys.length > 0) {
				const v = await this.vault.vault();
				for (const key of def.requiredVaultKeys) {
					const value = await v.get(key).catch(() => "");
					if (def.id === "discord" && key === "DISCORD_API_TOKEN" && !looksLikeDiscordBotToken(value)) {
						liveStatus = "invalid-token";
						liveDetail = `${key} doesn't look like a Discord bot token (expected ~70 chars with two dots; got ${value.length} chars, ${value.split(".").length - 1} dots).`;
					}
					if (def.id === "telegram" && key === "TELEGRAM_BOT_TOKEN" && !looksLikeTelegramBotToken(value)) {
						liveStatus = "invalid-token";
						liveDetail = `${key} doesn't look like a Telegram bot token (expected <id>:<35-char secret>).`;
					}
				}
			}

			// Real connection probe via the runtime service.
			if (liveStatus !== "invalid-token" && pluginLoaded && runtime) {
				const probed = probeChannelLive(runtime, def.id);
				liveStatus = probed.status;
				if (probed.detail) liveDetail = probed.detail;
			} else if (liveStatus !== "invalid-token" && pluginLoaded) {
				liveStatus = "loaded";
			}

			out.push({
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
				liveStatus,
				...(liveDetail ? { liveDetail } : {}),
			});
		}
		return { channels: out };
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
			const { ok } = await this.hasAllKeys(def.requiredVaultKeys);
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
