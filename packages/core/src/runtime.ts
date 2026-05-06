import {
	AgentRuntime,
	type Action,
	ChannelType,
	type Character,
	type Content,
	createCharacter,
	createMessageMemory,
	type Memory,
	type Plugin,
	provisionAgent,
	stringToUuid,
	type UUID,
} from "@elizaos/core";
import sqlPlugin from "@elizaos/plugin-sql";
import { v4 as uuidv4 } from "uuid";
import type { ModelProviderRoute, ProviderId } from "@detour/shared";
import type { VaultService } from "./vault";
import type { AuthService } from "./auth";
import { listAccounts, type AccountCredentialRecord } from "@elizaos/agent/auth";
import { embeddingStubPlugin } from "./embedding-stub-plugin";
// Note: plugin-local-embedding (eliza's bundled choice) drags in node-llama-cpp,
// transformers, and whisper — too heavy for our bundle and hangs startup.
// Until we ship a transformers.js-only local plugin, the OpenAI embeddings
// plugin handles real embeddings when the user has an OPENAI_EMBEDDING_API_KEY;
// otherwise embedding-stub keeps the runtime alive with zero vectors.
import { embeddingOpenAIPlugin } from "@detour/plugin-embedding-openai";
import { decodeCodexJwt } from "@detour/plugin-codex-chatgpt";
import { codexHatchAction, codexPetAction, codexPetsPlugin } from "@detour/plugin-codex-pets";
import { pensieveToolsPlugin } from "@detour/plugin-pensieve-tools";
import {
	browserFillLoginAction,
	browserInspectAction,
	browserOpenAction,
	browserScriptAction,
	loginListAction,
	vaultToolsPlugin,
} from "@detour/plugin-vault-tools";
import { cronToolsPlugin } from "@detour/plugin-cron-tools";
import { xTweetsPlugin } from "@detour/plugin-x-tweets";
import { makeOwnerBindPlugin } from "./owner-bind";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConfigService } from "./config-service";
import { toElizaCharacter } from "./agent-character";

/**
 * Read the system Codex CLI's auth.json (~/.codex/auth.json) — the file
 * `codex login` writes and that the Codex CLI itself refreshes on its own
 * cadence. By reading from this file we avoid making the user re-auth in
 * our app: as long as `codex` is logged in on the Mac, our agent uses it.
 *
 * File shape (verified May 2026 against codex@0.x):
 *   {
 *     "auth_mode": "ChatGPT" | "ApiKey",
 *     "OPENAI_API_KEY": null | string,
 *     "tokens": {
 *       "id_token": string,
 *       "access_token": string,
 *       "refresh_token": string,
 *       "account_id": string
 *     },
 *     "last_refresh": string  // ISO timestamp
 *   }
 *
 * Returns null if the file doesn't exist, can't be parsed, or has no usable
 * access token. The caller falls back to per-account OAuth or anthropic.
 */
async function detectSystemCodexAuth(): Promise<{ accessToken: string; accountId: string } | null> {
	const path = join(homedir(), ".codex", "auth.json");
	if (!existsSync(path)) return null;
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as {
			tokens?: { access_token?: string; account_id?: string };
		};
		const accessToken = parsed.tokens?.access_token;
		const accountId = parsed.tokens?.account_id;
		if (!accessToken || !accountId) return null;
		return { accessToken, accountId };
	} catch (err) {
		console.warn("[runtime] failed to read system Codex auth:", err instanceof Error ? err.message : err);
		return null;
	}
}

const ROOM_ID = stringToUuid("tray-app:default-room");
const WORLD_ID = stringToUuid("tray-app:default-world");
// Stable USER_ID derived deterministically — was previously `uuidv4()`, which
// minted a fresh random UUID on every restart. Eliza's shouldRespond
// classifier treats a never-seen entity in DM as a stranger and tends to
// IGNORE, which is why chat sends were producing trajectories with 0 LLM
// calls while the inbox/cron path (which uses a stable system entity) worked.
const USER_ID = stringToUuid("tray-app:default-user");

type NativeSlashDispatch =
	| { kind: "action"; action: Action; options: Record<string, string | boolean> }
	| { kind: "reply"; text: string };

function nativeSlashCommand(text: string): NativeSlashDispatch | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return null;
	const space = trimmed.search(/\s/);
	const command = (space < 0 ? trimmed : trimmed.slice(0, space)).toLowerCase();
	const tail = space < 0 ? "" : trimmed.slice(space + 1).trim();
	switch (command) {
		case "/help":
		case "/commands":
			return slashHelp();
		case "/browser":
		case "/open":
		case "/web":
		case "/internet":
			return slashBrowser(tail);
		case "/logins":
		case "/passwords":
			return { kind: "action", action: loginListAction, options: tail ? { domain: tail } : {} };
		case "/inspect":
		case "/read-page":
			return { kind: "action", action: browserInspectAction, options: {} };
		case "/script":
		case "/js":
			return slashScript(tail);
		case "/login":
		case "/fill-login":
			return slashLogin(tail);
		case "/1password":
		case "/op":
			return slashOnePassword(tail);
		case "/pet":
			return { kind: "action", action: codexPetAction, options: {} };
		case "/hatch":
			return { kind: "action", action: codexHatchAction, options: {} };
		default:
			return null;
	}
}

function slashHelp(): NativeSlashDispatch {
	return {
		kind: "reply",
		text: [
			"Native commands:",
			"/browser <url or search>",
			"/open <url or search>",
			"/inspect",
			"/script <javascript>",
			"/logins [domain]",
			"/login <source> <identifier> [url]",
			"/1password <identifier> [url]",
			"/pet [name]",
			"/hatch <concept>",
		].join("\n"),
	};
}

function slashBrowser(tail: string): NativeSlashDispatch {
	if (!tail) return { kind: "reply", text: "Usage: /browser <url or search>" };
	return { kind: "action", action: browserOpenAction, options: { url: tail, newTab: true } };
}

function slashScript(tail: string): NativeSlashDispatch {
	if (!tail) return { kind: "reply", text: "Usage: /script <javascript>" };
	return { kind: "action", action: browserScriptAction, options: { script: tail } };
}

function slashLogin(tail: string): NativeSlashDispatch {
	const parts = tail.split(/\s+/).filter(Boolean);
	const source = parts[0];
	const identifier = parts[1];
	if (source !== "in-house" && source !== "1password" && source !== "bitwarden") {
		return { kind: "reply", text: "Usage: /login <in-house|1password|bitwarden> <identifier> [url]" };
	}
	if (!identifier) return { kind: "reply", text: "Usage: /login <source> <identifier> [url]" };
	const targetUrl = parts.slice(2).join(" ");
	return {
		kind: "action",
		action: browserFillLoginAction,
		options: { source, identifier, ...(targetUrl ? { targetUrl, newTab: true } : {}) },
	};
}

function slashOnePassword(tail: string): NativeSlashDispatch {
	const parts = tail.split(/\s+/).filter(Boolean);
	const identifier = parts[0];
	if (!identifier) return { kind: "reply", text: "Usage: /1password <identifier> [url]" };
	const targetUrl = parts.slice(1).join(" ");
	return {
		kind: "action",
		action: browserFillLoginAction,
		options: { source: "1password", identifier, ...(targetUrl ? { targetUrl, newTab: true } : {}) },
	};
}

type RuntimeState = {
	runtime: AgentRuntime;
	provider: ProviderId | "codex-chatgpt";
};
type RuntimeProvider = RuntimeState["provider"];

const PROVIDER_PLUGINS: Record<ProviderId | "codex-chatgpt", () => Promise<Plugin>> = {
	anthropic: async () => (await import("@elizaos/plugin-anthropic")).default,
	openai: async () => (await import("@elizaos/plugin-openai")).default,
	openrouter: async () => (await import("@detour/plugin-openrouter")).default,
	"codex-chatgpt": async () => (await import("@detour/plugin-codex-chatgpt")).default,
};

type AfterBuildHook = (state: RuntimeState) => Promise<void> | void;

export class RuntimeService {
	private current: RuntimeState | null = null;
	private buildPromise: Promise<RuntimeState | null> | null = null;
	private providerPickPromise: Promise<RuntimeProvider | null> | null = null;
	private afterBuildHooks: AfterBuildHook[] = [];

	/**
	 * Subscribe to runtime-built events. Called once for every successful
	 * build (initial + every rebuild). Used by PensieveService to inject
	 * persisted prompt templates into runtime.character.templates so
	 * elizaOS's existing composePromptFromState picks them up.
	 */
	onAfterBuild(hook: AfterBuildHook): void {
		this.afterBuildHooks.push(hook);
	}

	private ownerBind?: import("./owner-bind").OwnerBindService;

	constructor(
		private readonly vault: VaultService,
		// auth dep is currently sourced via the singleton listAccounts() helper;
		// keeping the constructor slot lets callers pass it for future scoping.
		_auth?: AuthService,
		private readonly channels?: import("./channels").ChannelsService,
		private gateway?: import("./channels/gateway").ChannelGatewayService,
		private readonly config?: ConfigService,
	) {
		void _auth;
	}

	setGateway(gateway: import("./channels/gateway").ChannelGatewayService): void {
		this.gateway = gateway;
	}

	setOwnerBind(svc: import("./owner-bind").OwnerBindService): void {
		this.ownerBind = svc;
	}

	async getOrBuild(): Promise<RuntimeState | null> {
		if (this.current) return this.current;
		if (!this.buildPromise) {
			this.buildPromise = this.build()
				.then(async (state) => {
					this.current = state;
					if (state) {
						for (const hook of this.afterBuildHooks) {
							try { await hook(state); } catch (err) {
								console.warn("[runtime] afterBuild hook failed:", err instanceof Error ? err.message : err);
							}
						}
					}
					return state;
				})
				.finally(() => {
					this.buildPromise = null;
				});
		}
		return this.buildPromise;
	}

	/**
	 * Force-wire the /eliza_pair Telegram command after both the
	 * TelegramService and OWNER_BIND_VERIFY are loaded. Eliza's pairing
	 * service races against TelegramService.bot's init and can no-op the
	 * registration while still logging "registered". This bypasses the race
	 * by attaching the handler directly to the live Telegraf bot.
	 */
	private async wireTelegramPairCommand(runtime: import("@elizaos/core").IAgentRuntime): Promise<void> {
		const r = runtime as unknown as {
			getServiceLoadPromise?: (t: string) => Promise<unknown>;
			getService?: (t: string) => unknown;
		};
		// Wait for telegram + owner-bind to be live. Telegraf's startup
		// backoff (2+4+8+16 = 30s on 409-conflict retries) means we may need
		// a long timeout after a recent restart that left the bot's
		// long-poll lease still active on Telegram's side. 60s gives enough
		// headroom for the full retry cycle on a clean network.
		const tlg = await Promise.race([
			r.getServiceLoadPromise?.("telegram") ?? Promise.resolve(null),
			new Promise((res) => setTimeout(() => res(null), 60_000)),
		]);
		const verifySvc = r.getService?.("OWNER_BIND_VERIFY");
		if (!tlg || !verifySvc) {
			console.warn("[runtime] /eliza_pair wire skipped — telegram or owner-bind not loaded in 60s");
			return;
		}
		// Telegraf bot lives at TelegramService.bot. We don't have telegraf
		// in our deps (it's a transitive dep of @elizaos/plugin-telegram), so
		// duck-type the methods we need rather than importing the type.
		const bot = (tlg as { bot?: unknown }).bot as
			| { command: (n: string, h: (ctx: unknown) => Promise<void>) => void }
			| undefined;
		if (!bot || typeof bot.command !== "function") {
			console.warn("[runtime] /eliza_pair wire skipped — bot.command unavailable");
			return;
		}
		// Inline handler — eliza's handleElizaPairCommand isn't re-exported
		// from plugin-telegram's main entry, and the bun bundler can't
		// resolve deep imports. Reuse our OwnerBindService directly.
		const ownerBindSvc = this.ownerBind;
		bot.command("eliza_pair", async (ctx: unknown) => {
			console.log("[eliza_pair] command handler FIRED");
			try {
				const c = ctx as {
					message?: { text?: string; from?: { id?: number; username?: string; first_name?: string } };
					reply: (text: string) => Promise<unknown>;
				};
				const text = c.message?.text ?? "";
				const parts = text.split(/\s+/);
				const code = parts[1]?.trim();
				const from = c.message?.from;
				console.log(`[eliza_pair] text=${JSON.stringify(text)} code=${code} from=${from?.username ?? from?.id}`);
				if (!code || !/^\d{6}$/.test(code)) {
					await c.reply("usage: /eliza_pair <6-digit-code> — generate a code in Detour first.");
					return;
				}
				if (!from?.id) {
					await c.reply("could not read your Telegram user id from this chat.");
					return;
				}
				if (!ownerBindSvc) {
					await c.reply("owner-bind backend isn't loaded — restart Detour.");
					return;
				}
				const displayHandle = from.username ? `@${from.username}` : (from.first_name ?? String(from.id));
				const result = await ownerBindSvc.verifyOwnerBindFromConnector({
					connector: "telegram",
					externalId: String(from.id),
					displayHandle,
					code,
				});
				if (result.success) {
					await c.reply(`✅ paired. you (${displayHandle}, id ${from.id}) are now the owner of this Detour install.`);
				} else {
					await c.reply(`❌ pair failed: ${result.error ?? "unknown"}`);
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				try { await (ctx as { reply: (s: string) => Promise<unknown> }).reply(`error: ${msg}`); } catch { /* ignore */ }
			}
		});
		console.log("[runtime] /eliza_pair command wired into Telegraf bot (inline handler)");
		// Diag: log every inbound message so we can see if Telegraf is even
		// receiving anything. (Use bot.use to wrap; runs before command handlers.)
		const botUse = (bot as unknown as { use?: (mw: (ctx: unknown, next: () => Promise<unknown>) => Promise<unknown>) => void }).use;
		if (typeof botUse === "function") {
			botUse.call(bot, async (ctx: unknown, next: () => Promise<unknown>) => {
				const c = ctx as { updateType?: string; message?: { text?: string; from?: { username?: string; id?: number } } };
				const text = c.message?.text ?? "";
				const from = c.message?.from?.username ?? c.message?.from?.id ?? "?";
				console.log(`[telegram] inbound update=${c.updateType ?? "?"} from=${from} text=${JSON.stringify(text.slice(0, 60))}`);
				return next();
			});
			console.log("[runtime] telegram diag middleware installed");
		}
	}

	private async wireDiscordPairCommand(runtime: import("@elizaos/core").IAgentRuntime): Promise<void> {
		const r = runtime as unknown as {
			getServiceLoadPromise?: (t: string) => Promise<unknown>;
			getService?: (t: string) => unknown;
		};
		const dsc = await Promise.race([
			r.getServiceLoadPromise?.("discord") ?? Promise.resolve(null),
			new Promise((res) => setTimeout(() => res(null), 10_000)),
		]);
		const verifySvc = r.getService?.("OWNER_BIND_VERIFY");
		if (!dsc || !verifySvc) {
			console.warn("[runtime] /eliza-pair (discord) wire skipped — discord or owner-bind not loaded in 10s");
			return;
		}
		// Discord pairing wiring lives inside its own service — no clean
		// post-hoc hook for now. The eliza pairing service usually wires it
		// up correctly because Discord client init order differs from Telegraf.
		console.log("[runtime] discord pairing left to eliza's DiscordOwnerPairingService (no race observed)");
	}

	async rebuild(): Promise<RuntimeState | null> {
		if (this.current) {
			try {
				await this.current.runtime.stop();
			} catch (err) {
				console.error("Failed to stop runtime cleanly:", err);
			}
			this.current = null;
		}
		return this.getOrBuild();
	}

	/** Sync accessor — returns the cached runtime if built, or null. Used by
	 * pensieve queries that should never trigger a build. */
	peek(): import("@elizaos/core").IAgentRuntime | null {
		return this.current?.runtime ?? null;
	}

	getCurrentProvider(): ProviderId | null {
		const p = this.current?.provider;
		if (p === "codex-chatgpt") return "openai"; // surface as "openai" to existing UI consumers
		return p ?? null;
	}

	async sendMessage(
		text: string,
		onDelta: (delta: string) => void,
	): Promise<void> {
		const state = await this.getOrBuild();
		if (!state) {
			throw new Error("No LLM provider configured. Add an API key in Settings.");
		}
		const service = state.runtime.messageService;
		if (!service) {
			throw new Error(
				"Agent runtime has no messageService — check that @elizaos/plugin-sql initialised correctly.",
			);
		}
		// Ensure the entity/room/world exist before posting the memory —
		// eliza's messageService drops messages whose room isn't registered.
		// Mirror the inbox path's ensureConnection call exactly, including
		// type as the literal string "DM".
		try {
			await (state.runtime as unknown as {
				ensureConnection?: (opts: {
					entityId: string;
					roomId: string;
					worldId?: string;
					userName?: string;
					source?: string;
					channelId?: string;
					type?: string;
				}) => Promise<void>;
			}).ensureConnection?.({
				entityId: USER_ID,
				roomId: ROOM_ID,
				worldId: WORLD_ID,
				userName: "User",
				source: "tray-app",
				channelId: "chat",
				type: "DM",
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`Failed to prepare chat connection: ${msg}`);
		}
		// Build Memory directly instead of via createMessageMemory(). The
		// helper adds `metadata.scope: "private"` whenever agentId is set,
		// and that scope tag was causing eliza's planner to bail before
		// calling the LLM (chat trajectories had providerAccessCount=5 +
		// llmCallCount=0 — providers gathered, planner skipped). The inbox
		// path constructs Memory directly with no metadata, and that path
		// works (inbox trajectories show 10+ LLM calls). Mirror that shape.
		const message: Memory = {
			id: uuidv4() as UUID,
			entityId: USER_ID,
			agentId: state.runtime.agentId,
			roomId: ROOM_ID,
			content: { text, source: "tray-app", attachments: [] },
			createdAt: Date.now(),
		};
		const slash = nativeSlashCommand(text);
		if (slash) {
			let emitted = "";
			if (slash.kind === "reply") {
				onDelta(slash.text);
				emitted = slash.text;
			} else {
				const result = await slash.action.handler(state.runtime, message, undefined, slash.options, async (content: Content) => {
					const next = typeof content.text === "string" ? content.text : "";
					if (!next) return [];
					onDelta(next);
					emitted = next;
					return [];
				});
				if (!emitted && typeof result?.text === "string" && result.text.length > 0) {
					onDelta(result.text);
					emitted = result.text;
				}
			}
			if (this.gateway && emitted.length > 0) {
				this.gateway.recordChatReply({
					text: emitted,
					roomId: String(ROOM_ID),
					entityId: String(state.runtime.agentId),
					channel: "chat",
					source: "tray-app",
				});
			}
			return;
		}
		// Eliza's messageService can fire the callback multiple times per turn
		// (action result, post-action narration, etc.). Track what we've already
		// emitted so we don't duplicate text on the wire — emit only the diff
		// when the new content extends what we already sent, otherwise emit a
		// separator + the new chunk.
		let emitted = "";
		await service.handleMessage(state.runtime, message, async (content: { text?: string } | null | undefined) => {
			const text = typeof content?.text === "string" ? content.text : "";
			if (!text) return [];
			if (text === emitted) return [];
			if (text.startsWith(emitted) && emitted.length > 0) {
				onDelta(text.slice(emitted.length));
				emitted = text;
			} else {
				if (emitted.length > 0) onDelta("\n");
				onDelta(text);
				emitted = text;
			}
			return [];
		});
		// Gateway recording: in-app chat replies don't fire MESSAGE_SENT, so
		// record the assembled reply directly so it shows up alongside Discord/
		// Telegram outbound in the unified feed.
		if (this.gateway && emitted.length > 0) {
			this.gateway.recordChatReply({
				text: emitted,
				roomId: String(ROOM_ID),
				entityId: String(state.runtime.agentId),
				channel: "chat",
				source: "tray-app",
			});
		}
	}

	private async build(): Promise<RuntimeState | null> {
		await this.vault.loadKeysIntoEnv();
		const provider = await this.pickProvider();
		if (!provider) return null;

		const llmPlugin = await PROVIDER_PLUGINS[provider]();
		const character = await this.buildCharacter();
		const channelResolved = await this.resolveChannelPlugins();
		const settings = await this.buildRuntimeSettings(channelResolved.settings);

		const runtime = new AgentRuntime({
			character,
			plugins: this.basePlugins(llmPlugin),
			enableAutonomy: true,
			settings,
		});
		await runtime.initialize();
		await this.waitForOwnerBind(runtime);
		await this.registerChannelPlugins(runtime, channelResolved.plugins);
		this.wirePairingCommands(runtime);
		await this.provisionRuntime(runtime);
		this.startTaskServiceTimer(runtime);
		await runtime.ensureConnection({
			entityId: USER_ID,
			roomId: ROOM_ID,
			worldId: WORLD_ID,
			userName: "User",
			source: "tray-app",
			channelId: "chat",
			type: ChannelType.DM,
		});

		return { runtime, provider };
	}

	private async buildCharacter(): Promise<Character> {
		const characterConfig = this.config ? await this.config.getCharacter() : undefined;
		return createCharacter(toElizaCharacter(characterConfig ?? {
			name: "Detour Squirrel",
			username: "detour_squirrel",
			system: "You are Detour Squirrel, Dexploarer's sidequest agent.",
			bio: ["Dexploarer's sidequest agent"],
			lore: [],
			adjectives: ["useful"],
			topics: ["agents"],
			style: { all: [], chat: [], post: [] },
			postExamples: [],
			messageExamples: [],
		}));
	}

	private async resolveChannelPlugins(): Promise<{ plugins: Plugin[]; settings: Record<string, string> }> {
		const resolved = this.channels
			? await this.channels.resolvePlugins()
			: { plugins: [], settings: {} as Record<string, string> };
		if (resolved.plugins.length > 0) {
			console.log(`[runtime] loading ${resolved.plugins.length} channel plugin(s): ${resolved.plugins.map((p) => p.name).join(", ")}`);
		}
		return resolved;
	}

	private async buildRuntimeSettings(channelSettings: Record<string, string>): Promise<Record<string, string>> {
		const settings: Record<string, string> = {
			...channelSettings,
			EMBEDDING_DIMENSION: "384",
			OPENAI_EMBEDDING_DIMENSIONS: "384",
		};
		settings.TELEGRAM_AUTO_REPLY ??= "true";
		settings.DISCORD_AUTO_REPLY ??= "true";
		settings.DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS ??= "true";
		this.loadEmbeddingSettings(settings);
		await this.loadXSettings(settings);
		return settings;
	}

	private loadEmbeddingSettings(settings: Record<string, string>): void {
		const llamaUrl = process.env.OPENAI_EMBEDDING_URL;
		if (typeof llamaUrl === "string" && llamaUrl.length > 0 && !settings.OPENAI_EMBEDDING_URL) {
			settings.OPENAI_EMBEDDING_URL = llamaUrl;
		}
		if (process.env.OPENAI_EMBEDDING_API_KEY && !settings.OPENAI_EMBEDDING_API_KEY) {
			settings.OPENAI_EMBEDDING_API_KEY = process.env.OPENAI_EMBEDDING_API_KEY;
		}
	}

	private async loadXSettings(settings: Record<string, string>): Promise<void> {
		try {
			const v = await this.vault.vault();
			for (const key of ["X_AUTH_TOKEN", "X_CT0", "X_USER_AGENT"]) {
				if (await v.has(key)) {
					const val = await v.get(key);
					if (typeof val === "string" && val.length > 0) {
						settings[key] = val;
						process.env[key] = val;
					}
				}
			}
		} catch (err) {
			console.warn("[runtime] x-creds load failed:", err instanceof Error ? err.message : err);
		}
	}

	private basePlugins(llmPlugin: Plugin): Plugin[] {
		return [
			sqlPlugin,
			llmPlugin,
			embeddingOpenAIPlugin,
			embeddingStubPlugin,
			vaultToolsPlugin,
			pensieveToolsPlugin,
			codexPetsPlugin,
			xTweetsPlugin,
			cronToolsPlugin,
			...(this.ownerBind ? [makeOwnerBindPlugin(this.ownerBind)] : []),
		];
	}

	private async waitForOwnerBind(runtime: AgentRuntime): Promise<void> {
		if (!this.ownerBind) return;
		try {
			await (runtime as unknown as {
				getServiceLoadPromise?: (t: string) => Promise<unknown>;
			}).getServiceLoadPromise?.("OWNER_BIND_VERIFY");
			console.log("[runtime] OWNER_BIND_VERIFY started — channel plugins safe to load");
		} catch (err) {
			console.warn("[runtime] OWNER_BIND_VERIFY start failed:", err instanceof Error ? err.message : err);
		}
	}

	private async registerChannelPlugins(runtime: AgentRuntime, plugins: Plugin[]): Promise<void> {
		for (const channelPlugin of plugins) {
			try {
				await (runtime as unknown as {
					registerPlugin: (p: import("@elizaos/core").Plugin) => Promise<void>;
				}).registerPlugin(channelPlugin);
			} catch (err) {
				console.warn(`[runtime] failed to register channel plugin ${channelPlugin.name}:`, err instanceof Error ? err.message : err);
			}
		}
	}

	private wirePairingCommands(runtime: AgentRuntime): void {
		void this.wireTelegramPairCommand(runtime).catch((err) =>
			console.warn("[runtime] /eliza_pair wire failed:", err instanceof Error ? err.message : err),
		);
		void this.wireDiscordPairCommand(runtime).catch((err) =>
			console.warn("[runtime] /eliza-pair wire failed:", err instanceof Error ? err.message : err),
		);
	}

	private async provisionRuntime(runtime: AgentRuntime): Promise<void> {
		try {
			await provisionAgent(runtime, { runMigrations: false });
		} catch (err) {
			console.warn("[runtime] provisionAgent failed:", err instanceof Error ? err.message : err);
		}
	}

	private startTaskServiceTimer(runtime: AgentRuntime): void {
		try {
			const taskSvc = (runtime as unknown as {
				getService?: (t: string) => {
					startTimer?: () => void;
					markDirty?: () => void;
				} | null;
			}).getService?.("task");
			taskSvc?.startTimer?.();
			if (taskSvc?.markDirty) {
				const tick = setInterval(() => taskSvc.markDirty?.(), 2_000);
				(tick as unknown as { unref?: () => void }).unref?.();
			}
			console.log("[runtime] task service timer started + 2s mark-dirty pump");
		} catch (err) {
			console.warn("[runtime] task timer start failed:", err instanceof Error ? err.message : err);
		}
	}

	/**
	 * Pick a usable provider from OAuth subscription accounts.
	 *
	 *   openai-codex          → set CODEX_OAUTH_TOKEN + CODEX_CHATGPT_ACCOUNT_ID,
	 *     @detour/plugin-codex-chatgpt talks to chatgpt.com/backend-api/codex.
	 *   anthropic-subscription → fallback. Set ANTHROPIC_API_KEY = sk-ant-oat…,
	 *     plugin-anthropic + claude-code-stealth interceptor handle it.
	 *
	 * Codex/ChatGPT is preferred as the primary because it's not as
	 * aggressively rate-limited as the Anthropic Claude subscription tier.
	 *
	 * Auth source priority:
	 * Reading the system Codex CLI's auth means the user only logs in ONCE
	 * via the CLI (or ChatGPT desktop app, which writes the same file) and
	 * the desktop app picks it up automatically — no re-auth dance.
	 */
	private async resolveActiveProvider(provider: ProviderId): Promise<ProviderId | "codex-chatgpt" | null> {
		if (provider === "openrouter") {
			return this.hasEnvKey("OPENROUTER_API_KEY") ? "openrouter" : null;
		}
		if (provider === "openai") {
			return await this.pickOpenAiOAuth() ?? (this.hasEnvKey("OPENAI_API_KEY") ? "openai" : null);
		}
		return this.hasEnvKey("ANTHROPIC_API_KEY") ? "anthropic" : await this.pickAnthropicOAuth();
	}

	private async pickFromPriority(): Promise<ProviderId | "codex-chatgpt" | null> {
		const fallback: ModelProviderRoute[] = ["anthropic-subscription", "openai-codex", "openrouter-api", "anthropic-api", "openai-api"];
		const routes = this.config ? (await this.config.getModels()).providerPriority : fallback;
		for (const route of routes.length > 0 ? routes : fallback) {
			const provider = await this.pickRoute(route);
			if (provider) return provider;
		}
		return null;
	}

	private async pickRoute(route: ModelProviderRoute): Promise<ProviderId | "codex-chatgpt" | null> {
		if (route === "openai-codex") return this.pickOpenAiOAuth();
		if (route === "anthropic-subscription") return this.pickAnthropicOAuth();
		if (route === "openrouter-api") return this.hasEnvKey("OPENROUTER_API_KEY") ? "openrouter" : null;
		if (route === "anthropic-api") return this.hasEnvKey("ANTHROPIC_API_KEY") ? "anthropic" : null;
		if (route === "openai-api") return this.hasEnvKey("OPENAI_API_KEY") ? "openai" : null;
		return null;
	}

	private hasEnvKey(key: string): boolean {
		const value = process.env[key];
		return typeof value === "string" && value.length > 0;
	}

	private async pickProvider(): Promise<RuntimeProvider | null> {
		if (!this.providerPickPromise) {
			this.providerPickPromise = this.pickProviderUnlocked()
				.finally(() => {
					this.providerPickPromise = null;
				});
		}
		return this.providerPickPromise;
	}

	private async pickProviderUnlocked(): Promise<RuntimeProvider | null> {
		const activeProvider = await this.vault.getActiveProvider();
		return (activeProvider ? await this.resolveActiveProvider(activeProvider) : null)
			?? await this.pickFromPriority();
	}

	private async pickOpenAiOAuth(): Promise<"codex-chatgpt" | null> {
		const systemCodex = await detectSystemCodexAuth();
		if (systemCodex) {
			process.env.CODEX_OAUTH_TOKEN = systemCodex.accessToken;
			process.env.CODEX_CHATGPT_ACCOUNT_ID = systemCodex.accountId;
			console.log(
				`[runtime] using system Codex CLI auth from ~/.codex/auth.json (account_id=${systemCodex.accountId})`,
			);
			return "codex-chatgpt";
		}

		try {
			const codexAccounts = listAccounts("openai-codex") as AccountCredentialRecord[];
			const usable = codexAccounts
				.filter((a) => typeof a.credentials?.access === "string" && a.credentials.access.length > 0)
				.filter((a) => {
					const exp = a.credentials?.expires;
					return typeof exp !== "number" || exp <= 0 || exp > Date.now();
				});
			if (usable.length > 0) {
				const pick = usable[0]!;
				const token = pick.credentials!.access;
				const claims = decodeCodexJwt(token);
				const acctId = claims?.chatgptAccountId ?? "";
				if (acctId) {
					process.env.CODEX_OAUTH_TOKEN = token;
					process.env.CODEX_CHATGPT_ACCOUNT_ID = acctId;
					console.log(
						`[runtime] using openai-codex account "${pick.label}" (id=${pick.id}, chatgpt_account_id=${acctId})`,
					);
					return "codex-chatgpt";
				}
				console.warn("[runtime] codex token has no chatgpt_account_id claim");
			}
		} catch (err) {
			console.warn("[runtime] codex OAuth probe failed:", err instanceof Error ? err.message : err);
		}
		return null;
	}

	private async pickAnthropicOAuth(): Promise<"anthropic" | null> {
		try {
			const anthropicAccounts = listAccounts("anthropic-subscription") as AccountCredentialRecord[];
			const usable = anthropicAccounts
				.filter((a) => typeof a.credentials?.access === "string" && a.credentials.access.startsWith("sk-ant-oat"))
				.filter((a) => {
					const exp = a.credentials?.expires;
					return typeof exp !== "number" || exp <= 0 || exp > Date.now();
				});
			if (usable.length > 0) {
				const pick = usable[0]!;
				process.env.ANTHROPIC_API_KEY = pick.credentials!.access;
				console.log(`[runtime] using anthropic-subscription account "${pick.label}" (id=${pick.id})`);
				return "anthropic";
			}
		} catch (err) {
			console.warn("[runtime] anthropic OAuth probe failed:", err instanceof Error ? err.message : err);
		}

		return null;
	}
}
