import {
	AgentRuntime,
	type Action,
	ChannelType,
	type Character,
	type Content,
	createCharacter,
	logger,
	type Memory,
	type Plugin,
	provisionAgent,
	stringToUuid,
	type UUID,
} from "@elizaos/core";
import sqlPlugin from "@elizaos/plugin-sql";
import { v4 as uuidv4 } from "uuid";
import type { ProviderId } from "../../shared/index";
import type { VaultService } from "./vault";

import { listAccounts, saveAccount, refreshAnthropicToken, type AccountCredentialRecord } from "@elizaos/agent/auth";
import { embeddingStubPlugin } from "./embedding-stub-plugin";
// Note: plugin-local-embedding (eliza's bundled choice) drags in node-llama-cpp,
// transformers, and whisper — too heavy for our bundle and hangs startup.
// Until we ship a transformers.js-only local plugin, the OpenAI embeddings
// plugin handles real embeddings when the user has an OPENAI_EMBEDDING_API_KEY;
// otherwise embedding-stub keeps the runtime alive with zero vectors.
import { embeddingOpenAIPlugin } from "../plugins/embedding-openai/index";
import { localChatPlugin } from "../plugins/local-chat/index";
import { devInferencePlugin } from "../plugins/dev-inference/index";
import { decodeCodexJwt } from "../plugins/codex-chatgpt/index";
import { codexHatchAction, codexPetAction, codexPetsPlugin } from "../plugins/codex-pets/index";
import {
	codexSkillInvocationPrompt,
	codexSkillsListText,
	codexSkillsPlugin,
	findCodexSkill,
} from "./codex-skills";
import { pensieveToolsPlugin } from "../plugins/pensieve-tools/index";
import { contactDossierPlugin } from "../plugins/contact-dossier/index";
import {
	browserFillLoginAction,
	browserInspectAction,
	browserOpenAction,
	browserScreenshotAction,
	browserScriptAction,
	loginListAction,
	vaultToolsPlugin,
} from "../plugins/vault-tools/index";
import { xTweetsPlugin } from "../plugins/x-tweets/index";
import { codingToolsPlugin } from "@elizaos/plugin-coding-tools";
// Eliza optional capabilities — registered conditionally in basePlugins so
// they stay inert (and quiet) until their key/config is present.
import webSearchPlugin from "@elizaos-plugins/plugin-web-search";
import mcpPlugin from "@elizaos/plugin-mcp";
import { cloudAppsPlugin } from "../plugins/cloud-apps/index";
import { agentProjectsPlugin } from "../plugins/agent-projects/index";
import { capabilitiesPlugin } from "../plugins/capabilities/index";
import { detourGoalPlugin } from "../plugins/detour-goal/index";
import { detourDiscordMediaPlugin } from "../plugins/discord-media/index";
import { detourTelegramMediaPlugin } from "../plugins/telegram-media/index";
import { detourIMessageMediaPlugin } from "../plugins/imessage-media/index";
import { portlessToolsPlugin } from "../plugins/portless-tools/index";
import { agentSkillsPlugin } from "../plugins/agent-skills/index";
import { agentPublicLogPlugin } from "../plugins/agent-public-log/index";
import { trajectoryLessonsPlugin } from "../plugins/trajectory-lessons/index";
import { openQuestionsPlugin } from "../plugins/open-questions/index";
import { phantomWalletToolsPlugin } from "../plugins/phantom-wallet-tools/index";
import { gmgnToolsPlugin } from "../plugins/gmgn-tools/index";
import { audioGenerationPlugin } from "../plugins/audio-generation/index";
import { mediaGenerationPlugin } from "../plugins/media-generation/index";
import { modelRouterPlugin } from "../plugins/model-router/index";
import {
	AUDIO_RUNTIME_SETTING_KEYS,
	EMBEDDING_RUNTIME_SETTING_KEYS,
	MEDIA_GENERATION_SETTING_KEYS,
	X_RUNTIME_SETTING_KEYS,
} from "../../shared/settings-registry";
import { readChromeXCookies } from "./chrome-cookies";
import { computerScreenshotAction, desktopControlPlugin } from "../plugins/desktop-control/index";
import { macAutomatePlugin } from "../plugins/mac-automate/index";
// Orchestrator ships from the eliza submodule. Guarded import — node-pty
// build can fail on first install; if the dist isn't there the plugin
// stays null. Service start() failures are absorbed by the wrapper below
// so a broken PTY layer can't crash detour boot — the plugin's actions
// will return errors at call time instead.
let agentOrchestratorPlugin: Plugin | null = null;
try {
	const m = await import("@elizaos/plugin-agent-orchestrator");
	const raw = (m.default ?? null) as Plugin | null;
	if (raw) {
		// Wrap each service class so a thrown start() inside PTYService or
		// CodingWorkspaceService doesn't propagate up through
		// runtime.initialize() and abort all provider attempts. ElizaOS
		// calls `ServiceClass.start(runtime)` as a static factory; a Proxy
		// on the class lets us intercept that one call while leaving
		// everything else (instanceof, prototype chain, static fields) alone.
		type ServiceCtor = { start?: (rt: unknown) => Promise<unknown>; serviceType?: string; name?: string };
		const wrappedServices = (raw.services ?? []).map((svc) => {
			const ctor = svc as unknown as ServiceCtor;
			if (typeof ctor.start !== "function") return svc;
			const proxied = new Proxy(ctor, {
				get(target, prop, receiver) {
					if (prop === "start") {
						return async (rt: unknown) => {
							try {
								return await (target.start as NonNullable<ServiceCtor["start"]>).call(target, rt);
							} catch (err) {
								logger.warn(
									{ src: "runtime", service: target.serviceType ?? target.name ?? "?" },
									"orchestrator service start failed (boot continuing without it): %s",
									err instanceof Error ? err.message : err,
								);
								return null;
							}
						};
					}
					return Reflect.get(target, prop, receiver);
				},
			});
			return proxied as unknown as typeof svc;
		});
		agentOrchestratorPlugin = { ...raw, services: wrappedServices };
	}
} catch (err) {
	logger.warn({ src: "runtime" }, " orchestrator plugin unavailable:", err instanceof Error ? err.message : err);
	agentOrchestratorPlugin = null;
}
import { broadcaster } from "./rpc/registry";
import { createWorkerStatusRelay } from "./worker-status-relay";
import { makeOwnerBindPlugin } from "./owner-bind";
import { discordMentionAliasPlugin, installDiscordMentionAliasPatch, installDiscordMessageManagerGuard } from "./discord-mention-alias-plugin";
import { discordContextPlugin } from "./discord-context-provider";
import { dpeFallbackPlugin, installDpeFallbackPatch } from "./dpe-fallback-plugin";
import { installFreeformPlannerPatch } from "./freeform-planner";
import { getProviderQuotaService } from "./provider-quota-service";
import { installAnthropicAccountPool } from "./anthropic-account-pool";
import { runDiscordCatchUp } from "./discord-catchup";
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
		logger.warn({ src: "runtime" }, " failed to read system Codex auth:", err instanceof Error ? err.message : err);
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

/** Options for `sendMessage` that enable per-source room routing. */
export interface SendMessageOpts {
	/** Logical source identifier (e.g. "eval", "chat", "cron:x-mentions"). */
	source?: string;
	/** Conversation id — same id routes to the same room for context continuity. */
	conversationId?: string;
}

/**
 * Per-source room routing: different sources (eval, chat, cron) each get
 * their own ElizaOS room so `DefaultMessageService.handleMessage` can
 * process them concurrently. The inbox already does this (inbox:room:${kind})
 * and the AutonomyService creates its own autonomousRoomId. This extends
 * the pattern to the RuntimeService.sendMessage path.
 *
 * Rooms are cached so repeated calls with the same source reuse the same
 * room (preserving conversation history within a source).
 */
const sourceRoomCache = new Map<string, UUID>();
function roomForSource(source: string | undefined): UUID {
	if (!source || source === "chat") return ROOM_ID;
	const cached = sourceRoomCache.get(source);
	if (cached) return cached;
	const id = stringToUuid(`tray-app:room:${source}`);
	sourceRoomCache.set(source, id);
	return id;
}
function entityForSource(source: string | undefined): UUID {
	if (!source || source === "chat") return USER_ID;
	return stringToUuid(`tray-app:entity:${source}`);
}
type NativeSlashDispatch =
	| { kind: "action"; action: Action; options: Record<string, string | boolean> }
	| { kind: "reply"; text: string }
	// Renders a Codex skill's invocation prompt and runs it as a
	// regular chat turn (not a slash action). The text replaces the
	// user's `/skill foo bar` and goes through the LLM pipeline.
	| { kind: "prompt"; text: string };

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
		case "/browser-screenshot":
		case "/screenshot-browser":
			return { kind: "action", action: browserScreenshotAction, options: {} };
		case "/screenshot":
		case "/screen":
		case "/computer-screenshot":
			return { kind: "action", action: computerScreenshotAction, options: {} };
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
		case "/skills":
			return { kind: "reply", text: codexSkillsListText() };
		case "/skill":
			return slashSkill(tail);
		default:
			// Fall through to skill-named matching: a user can type
			// `/<skill-command> <task>` and we'll find the skill and
			// render its invocation prompt. Unknown commands still
			// return null (regular chat).
			return slashNamedSkill(command, tail);
	}
}

function slashSkill(tail: string): NativeSlashDispatch {
	const match = tail.match(/^(\S+)(?:\s+([\s\S]*))?$/);
	const name = match?.[1] ?? "";
	if (!name) return { kind: "reply", text: "Usage: /skill <name> <task>" };
	const skill = findCodexSkill(name);
	if (!skill) return { kind: "reply", text: `No Codex skill matched "${name}".` };
	return { kind: "prompt", text: codexSkillInvocationPrompt(skill, match?.[2] ?? "") };
}

function slashNamedSkill(command: string, tail: string): NativeSlashDispatch | null {
	const skill = findCodexSkill(command);
	if (!skill) return null;
	return { kind: "prompt", text: codexSkillInvocationPrompt(skill, tail) };
}

function slashHelp(): NativeSlashDispatch {
	return {
		kind: "reply",
		text: [
			"Native commands:",
			"/browser <url or search>",
			"/open <url or search>",
			"/inspect",
			"/browser-screenshot",
			"/screenshot",
			"/script <javascript>",
			"/logins [domain]",
			"/login <source> <identifier> [url]",
			"/1password <identifier> [url]",
			"/pet [name]",
			"/hatch <concept>",
			"/skills",
			"/skill <name> <task>",
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
	providerId: ProviderId;
	attemptId: string;
};
type RuntimeProvider = RuntimeState["provider"];

const PROVIDER_PLUGINS: Record<ProviderId | "codex-chatgpt", () => Promise<Plugin>> = {
	anthropic: async () => (await import("@elizaos/plugin-anthropic")).default,
	openai: async () => (await import("@elizaos/plugin-openai")).default,
	openrouter: async () => (await import("../plugins/openrouter/index")).default,
	elizacloud: async () => (await import("@elizaos/plugin-elizacloud")).default,
	"codex-chatgpt": async () => (await import("../plugins/codex-chatgpt/index")).default,
};

export const LLM_ACTIVE_PLUGIN_PRIORITY = 100;
export const LLM_RECOVERY_PLUGIN_PRIORITY = -100;

/**
 * Pins the active provider's LLM plugin to win every default
 * `useModel(TEXT_LARGE)` / `OBJECT_LARGE` / etc resolution, while keeping
 * recovery plugins reachable via the explicit `options.model` lookup that
 * `dpe-fallback-plugin` uses.
 *
 * Critical: when more than one LLM plugin is loaded (e.g. Anthropic OAuth
 * is paired AND an OPENROUTER_API_KEY is in the vault for recovery), every
 * plugin registers its own TEXT_LARGE / OBJECT_LARGE / etc handlers at the
 * same default priority (0). elizaOS's `resolveModelRegistration` picks
 * the highest-priority entry and falls back to registration order on
 * ties — which is non-deterministic across dynamic imports and would let
 * a non-active provider win default `useModel` calls.
 *
 * We saw exactly this in production: with Anthropic marked active,
 * autonomy / inbox / X-autonomy `useModel(TEXT_LARGE)` calls routed to
 * OpenRouter's `openrouter/free` handler (→ google/gemma-4-31b-it:free)
 * instead, because of registration-order ties.
 *
 * Inputs `plugins[0]` is the active attempt's plugin; the rest are
 * recovery plugins, in the order they were resolved.
 */
export function tagLlmPluginPriorities(plugins: Plugin[]): Plugin[] {
	return plugins.map((plugin, idx) => ({
		...plugin,
		priority: idx === 0 ? LLM_ACTIVE_PLUGIN_PRIORITY : LLM_RECOVERY_PLUGIN_PRIORITY,
	}));
}

// ── Embedding dimension resolution ───────────────────────────────
/**
 * Resolve embedding vector dimension based on the active embedding
 * provider. Safe default is 384 (bge-small-en-v1.5 native) which also
 * works for cloud providers that support the `dimensions` truncation
 * param (e.g. OpenAI text-embedding-3-small). Users override via the
 * OPENAI_EMBEDDING_DIMENSIONS env var for full-resolution vectors.
 *
 * When a cloud provider's native dim differs from 384, a warning is
 * logged so the user knows they can opt into full-resolution embeddings
 * by setting the env var and re-embedding memories.
 */
const EMBEDDING_PROVIDER_NATIVE_DIMS: Record<string, number> = {
	"local-bge": 384,
	openai: 1536,
	openrouter: 1536,
};

function resolveEmbeddingDimension(): string {
	// Explicit user override always wins.
	const explicit = process.env.OPENAI_EMBEDDING_DIMENSIONS;
	if (typeof explicit === "string" && explicit.length > 0) {
		const parsed = Number.parseInt(explicit, 10);
		if (Number.isFinite(parsed) && parsed > 0) return String(parsed);
	}
	const provider = process.env.DETOUR_MODEL_TEXT_EMBEDDING_PROVIDER;
	if (!provider || provider === "local-bge") return "384";
	const nativeDim = EMBEDDING_PROVIDER_NATIVE_DIMS[provider];
	if (nativeDim && nativeDim !== 384) {
		logger.warn(
			{ src: "runtime", provider, nativeDim },
			`embedding provider native dim=${nativeDim}; using 384 for PGlite compat. Set OPENAI_EMBEDDING_DIMENSIONS=${nativeDim} and re-embed memories for full-resolution vectors.`,
		);
	}
	return "384";
}

const ANTHROPIC_REFRESH_TIMEOUT_MS = 5_000;

/** Timeout constants — centralized for easy tuning. */
const TELEGRAM_SERVICE_LOAD_TIMEOUT_MS = 60_000;
const DISCORD_SERVICE_LOAD_TIMEOUT_MS = 10_000;
const TASK_DIRTY_PUMP_INTERVAL_MS = 2_000;

type ProviderAttempt = {
	id: string;
	label: string;
	providerId: ProviderId;
	runtimeProvider: RuntimeProvider;
	prepare: () => Promise<void> | void;
};

type BuildAttemptOptions = {
	channels: boolean;
};

type AfterBuildHook = (state: RuntimeState) => Promise<void> | void;

export class RuntimeService {
	private current: RuntimeState | null = null;
	/**
	 * Serializes every path that calls `build()` / `activateState` so
	 * overlapping `getOrBuild` and `rebuild` cannot interleave (stale
	 * vault snapshot vs fresh `current`, or two builds racing on
	 * `current`). Replaces the old `buildPromise` coalescer.
	 */
	private buildSerializeTail: Promise<unknown> = Promise.resolve();
	/** Task service mark-dirty pump interval — cleared on stopCurrentRuntime. */
	private markDirtyInterval: ReturnType<typeof setInterval> | null = null;

	private enqueueSerializedBuild<T>(fn: () => Promise<T>): Promise<T> {
		const job = this.buildSerializeTail.then(() => fn());
		this.buildSerializeTail = job.then(
			() => undefined,
			() => undefined,
		);
		return job;
	}

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
	private extraPlugins: Plugin[] = [];

	/**
	 * Plugins contributed by the carrot bridge. Appended to basePlugins on
	 * the next runtime build. Called from startCore after carrots load.
	 */
	setExtraPlugins(plugins: Plugin[]): void {
		this.extraPlugins = plugins;
	}

	constructor(
		private readonly vault: VaultService,
		private readonly channels?: import("./channels").ChannelsService,
		private gateway?: import("./channels/gateway").ChannelGatewayService,
		private readonly config?: ConfigService,
	) {
		// Plug Detour into plugin-anthropic's multi-account pool shim. The
		// plugin's 429 handler reports rate-limits + the OAuth fetch picks
		// the next account through this shim — without it, Claude Pro caps
		// are silent and account rotation never happens.
		installAnthropicAccountPool();
	}

	setGateway(gateway: import("./channels/gateway").ChannelGatewayService): void {
		this.gateway = gateway;
	}

	setOwnerBind(svc: import("./owner-bind").OwnerBindService): void {
		this.ownerBind = svc;
	}

	/**
	 * Wire the GoalService AFTER the runtime is constructed. core/index.ts
	 * builds GoalService once Pensieve is up; from then on every
	 * `sendMessage` turn checks for an active conversation goal and lazily
	 * extracts one from the first substantive user turn.
	 */
	private goalService?: import("./goal-service").GoalService;
	setGoalService(svc: import("./goal-service").GoalService): void {
		this.goalService = svc;
	}

	async getOrBuild(): Promise<RuntimeState | null> {
		return this.enqueueSerializedBuild(async () => {
			if (this.current) return this.current;
			const state = await this.build();
			return this.activateState(state);
		});
	}

	private async activateState(state: RuntimeState | null): Promise<RuntimeState | null> {
		this.current = state;
		if (!state) {
			getProviderQuotaService().setActiveCredential(null, null);
			return null;
		}
		// Tell the quota service which credential is now live so
		// `getActiveCap()` resolves to the correct one and the chat banner
		// surfaces the matching cap. The account-id env vars are set by
		// the attempt's `prepare()` step a few stack frames up.
		const activeAccountId =
			process.env.CODEX_CHATGPT_ACCOUNT_ID ??
			process.env.ANTHROPIC_ACCOUNT_ID ??
			"primary";
		getProviderQuotaService().setActiveCredential(state.providerId, activeAccountId);
		for (const hook of this.afterBuildHooks) {
			try { await hook(state); } catch (err) {
				logger.warn({ src: "runtime" }, " afterBuild hook failed:", err instanceof Error ? err.message : err);
			}
		}
		return state;
	}

	/**
	 * Force-wire the /eliza_pair Telegram command after both the
	 * TelegramService and OWNER_BIND_VERIFY are loaded. Eliza's pairing
	 * service races against TelegramService.bot's init and can no-op the
	 * registration while still logging "registered". This bypasses the race
	 * by attaching the handler directly to the live Telegraf bot.
	 */
	private async wireTelegramPairCommand(runtime: import("@elizaos/core").IAgentRuntime): Promise<void> {
		// Wait for telegram + owner-bind to be live. Telegraf's startup
		// backoff (2+4+8+16 = 30s on 409-conflict retries) means we may need
		// a long timeout after a recent restart that left the bot's
		// long-poll lease still active on Telegram's side. 60s gives enough
		// headroom for the full retry cycle on a clean network.
		const tlg = await Promise.race([
			runtime.getServiceLoadPromise("telegram").catch(() => null),
			new Promise((res) => setTimeout(() => res(null), TELEGRAM_SERVICE_LOAD_TIMEOUT_MS)),
		]);
		const verifySvc = runtime.getService("OWNER_BIND_VERIFY");
		if (!tlg || !verifySvc) {
			logger.warn({ src: "runtime" }, "/eliza_pair wire skipped — telegram or owner-bind not loaded in time");
			return;
		}
		// Telegraf bot lives at TelegramService.bot. We don't have telegraf
		// in our deps (it's a transitive dep of @elizaos/plugin-telegram), so
		// duck-type the methods we need rather than importing the type.
		const bot = (tlg as { bot?: unknown }).bot as
			| { command: (n: string, h: (ctx: unknown) => Promise<void>) => void }
			| undefined;
		if (!bot || typeof bot.command !== "function") {
			logger.warn({ src: "runtime" }, "/eliza_pair wire skipped — bot.command unavailable");
			return;
		}
		// Inline handler — eliza's handleElizaPairCommand isn't re-exported
		// from plugin-telegram's main entry, and the bun bundler can't
		// resolve deep imports. Reuse our OwnerBindService directly.
		const ownerBindSvc = this.ownerBind;
		bot.command("eliza_pair", async (ctx: unknown) => {
			logger.debug({ src: "runtime" }, "eliza_pair command handler fired");
			try {
				const c = ctx as {
					message?: { text?: string; from?: { id?: number; username?: string; first_name?: string } };
					reply: (text: string) => Promise<unknown>;
				};
				const text = c.message?.text ?? "";
				const parts = text.split(/\s+/);
				const code = parts[1]?.trim();
				const from = c.message?.from;
				logger.debug({ src: "runtime", code, from: from?.username ?? from?.id }, "eliza_pair attempt");
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
		logger.info({ src: "runtime" }, "/eliza_pair command wired into Telegraf bot");
		// Diag: log every inbound message so we can see if Telegraf is even
		// receiving anything. (Use bot.use to wrap; runs before command handlers.)
		const botUse = (bot as unknown as { use?: (mw: (ctx: unknown, next: () => Promise<unknown>) => Promise<unknown>) => void }).use;
		if (typeof botUse === "function") {
			botUse.call(bot, async (ctx: unknown, next: () => Promise<unknown>) => {
				const c = ctx as { updateType?: string; message?: { text?: string; from?: { username?: string; id?: number } } };
				const text = c.message?.text ?? "";
				const from = c.message?.from?.username ?? c.message?.from?.id ?? "?";
				logger.debug({ src: "runtime", updateType: c.updateType ?? "?", from }, "telegram inbound");
				return next();
			});
			logger.debug({ src: "runtime" }, "telegram diag middleware installed");
		}
	}

	private async wireDiscordPairCommand(runtime: import("@elizaos/core").IAgentRuntime): Promise<void> {
		const dsc = await Promise.race([
			runtime.getServiceLoadPromise("discord").catch(() => null),
			new Promise((res) => setTimeout(() => res(null), DISCORD_SERVICE_LOAD_TIMEOUT_MS)),
		]);
		const verifySvc = runtime.getService("OWNER_BIND_VERIFY");
		if (!dsc || !verifySvc) {
			logger.warn({ src: "runtime" }, "/eliza-pair (discord) wire skipped — discord or owner-bind not loaded in time");
			return;
		}
		// Discord pairing wiring lives inside its own service — no clean
		// post-hoc hook for now. The eliza pairing service usually wires it
		// up correctly because Discord client init order differs from Telegraf.
		logger.debug({ src: "runtime" }, "discord pairing left to eliza's DiscordOwnerPairingService");
	}

	/**
	 * Replaces the live `AgentRuntime` (SQL init, plugin init, Pensieve hooks).
	 * Triggered by credential/provider/config RPC paths and a debounced channel
	 * reload — not on a timer. `electrobun dev --watch` restarts the whole host
	 * separately; that can look like repeated init in logs during active dev.
	 */
	async rebuild(): Promise<RuntimeState | null> {
		return this.enqueueSerializedBuild(async () => {
			await this.stopCurrentRuntime();
			const state = await this.build();
			return this.activateState(state);
		});
	}

	private async stopCurrentRuntime(): Promise<void> {
		if (this.markDirtyInterval) {
			clearInterval(this.markDirtyInterval);
			this.markDirtyInterval = null;
		}
		if (!this.current) return;
		try {
			await this.current.runtime.stop();
		} catch (err) {
			logger.error({ src: "runtime", err: err instanceof Error ? err.message : String(err) }, "failed to stop runtime cleanly");
		}
		this.current = null;
	}

	/** Sync accessor — returns the cached runtime if built, or null. Used by
	 * pensieve queries that should never trigger a build. */
	peek(): import("@elizaos/core").IAgentRuntime | null {
		return this.current?.runtime ?? null;
	}

	getCurrentProvider(): ProviderId | null {
		return this.current?.providerId ?? null;
	}

	/**
	 * The credential variant currently bound to the live runtime — used by
	 * cap-driven rotation to ask the next rebuild to skip this specific
	 * attempt (the one that just 429'd).
	 */
	getCurrentAttemptId(): string | null {
		return this.current?.attemptId ?? null;
	}

	/**
	 * Cap-driven rebuild. Walks past credentials currently blocked on
	 * `ProviderQuotaService` (caller assembles the blocked set from quota
	 * state) and activates the next usable one. Returns the new state or
	 * null if no provider is wired at all. Throws when every attempt is
	 * blocked / errored — the user sees the "all credentials capped"
	 * banner with the next reset time.
	 */
	private async rebuildSkipping(
		blockedAttemptIds: ReadonlySet<string>,
	): Promise<RuntimeState | null> {
		return this.enqueueSerializedBuild(async () => {
			await this.stopCurrentRuntime();
			const state = await this.build(blockedAttemptIds);
			return this.activateState(state);
		});
	}

	/**
	 * Deliver one chat turn through the chosen provider.
	 *
	 * Single-shot — no silent rebuild-and-retry-with-a-different-provider
	 * loop. If `build()` already walked the active provider's credential
	 * variants and none worked, the user sees one explicit error in chat
	 * (e.g. "Active provider 'openai' failed: Codex OAuth expired | API
	 * key …") instead of the runtime quietly swapping to a different
	 * provider behind their back. Same for `deliverMessage` errors: they
	 * propagate, the planner / DPE-fallback layer in core handles the
	 * user-facing reply.
	 */
	async sendMessage(
		text: string,
		onDelta: (delta: string) => void,
		msgOpts?: SendMessageOpts,
	): Promise<void> {
		let state = await this.getOrBuild();
		if (!state) throw new Error("No LLM provider configured. Add an API key in Settings.");
		// Pre-flight: if the active credential is currently quota-capped, try
		// to rotate to the next non-capped attempt in the user's fallback
		// order before failing. fb54849b's intent stands — this walk is only
		// for `usage_limit_reached` (not transient 429s or 503s), the order
		// is USER-set in Settings → Providers, and the rotation is surfaced
		// in the chat banner. It is not a silent walk.
		state = await this.rotatePastCapsIfNeeded(state);
		const activeCap = getProviderQuotaService().getActiveCap();
		// Detour's local-chat service (Qwen3 running on-device) is a valid
		// uncapped fallback. When it's running, don't bail with the cap
		// error — let deliverMessage proceed; dpe-fallback's recovery
		// chain will route the turn through local-chat. This is what
		// makes Detour survive a cloud-provider cap on its own infra.
		const localChatAvailable =
			typeof process.env.DETOUR_LOCAL_CHAT_URL === "string" &&
			process.env.DETOUR_LOCAL_CHAT_URL.trim().length > 0;
		if (activeCap && !localChatAvailable) {
			const resetText = new Date(activeCap.resetsAtMs).toLocaleString();
			throw new Error(
				`${activeCap.accountLabel} cap reached (resets ${resetText}) and no uncapped fallback is configured. ` +
				`Switch active provider in Settings → Providers, add a fallback to the order, or wait for the cap to reset.`,
			);
		}
		if (activeCap && localChatAvailable) {
			logger.info(
				{ src: "runtime", cappedAccount: activeCap.accountLabel, localChatUrl: process.env.DETOUR_LOCAL_CHAT_URL },
				"active provider capped — routing through local-chat",
			);
		}
		// Resolve the room for this source. Chat UI and unspecified sources
		// use the default ROOM_ID; eval/cron/conversationId each get their
		// own room so they process concurrently.
		const routeSource = msgOpts?.conversationId ?? msgOpts?.source;
		const slashEarly = nativeSlashCommand(text);
		if (slashEarly?.kind === "prompt") {
			// Skill-rendered prompt: route through the regular chat
			// pipeline (LLM + tools) by replacing the user's text
			// and falling out of the slash branch.
			this.maybeCaptureGoal(slashEarly.text, routeSource);
			await this.deliverMessage(state, slashEarly.text, onDelta, /* asNativeSlash */ false, routeSource);
			return;
		}
		this.maybeCaptureGoal(text, routeSource);
		await this.deliverMessage(state, text, onDelta, /* asNativeSlash */ true, routeSource);
	}

	/**
	 * Background goal extraction. Returns immediately so the chat pipeline
	 * never waits on the extraction LLM call. By the time the user's NEXT
	 * turn composes state, the goal will be persisted and the
	 * DETOUR_ACTIVE_GOAL provider will surface it. Losing the goal on turn
	 * 1 is acceptable; blocking the first reply by 2-5s while we extract
	 * is not. Failure is logged but never propagated.
	 */
	private maybeCaptureGoal(text: string, source?: string): void {
		const service = this.goalService;
		if (!service) return;
		const goalRoomId = roomForSource(source);
		void service.ensureGoalForTurn(String(goalRoomId), text).catch((err) => {
			logger.warn(
				{ src: "runtime", err: err instanceof Error ? err.message : err },
				"goal extraction failed",
			);
		});
	}

	/**
	 * If the currently-active credential is rate-capped, attempt to rebuild
	 * with that credential blocked so the runtime walks to the next entry
	 * in the user's fallback chain. Returns the new state when a rotation
	 * happened, or the original state when no cap was active. Returns null
	 * only when no provider is wired at all — caller throws the actionable
	 * "no provider" message.
	 *
	 * Idempotent: collects ALL currently-capped credential ids in one shot
	 * and rebuilds once with them excluded, instead of looping rebuilds
	 * per cap (which would compound across turns).
	 */
	private async rotatePastCapsIfNeeded(
		state: RuntimeState,
	): Promise<RuntimeState> {
		const service = getProviderQuotaService();
		const cap = service.getActiveCap();
		if (!cap) return state;
		const currentAttempt = this.getCurrentAttemptId();
		const blocked = new Set<string>();
		if (currentAttempt) blocked.add(currentAttempt);
		// Pull every currently-capped credential into the blocklist so a
		// single rebuild jumps past all of them rather than swapping into
		// another already-capped attempt.
		for (const c of service.listCaps()) {
			blocked.add(`${c.providerId}:oauth:${c.accountId}`);
			blocked.add(`${c.providerId}:oauth:system-codex`);
			blocked.add(`${c.providerId}:api`);
			blocked.add(`${c.providerId}:api:${c.accountId}`);
		}
		try {
			const next = await this.rebuildSkipping(blocked);
			return next ?? state;
		} catch (err) {
			// Every credential is blocked — let the caller throw the
			// actionable error in sendMessage's pre-flight branch.
			logger.warn(
				{ src: "runtime", err: err instanceof Error ? err.message : err },
				"cap-driven rebuild exhausted all attempts",
			);
			return state;
		}
	}

	private async deliverMessage(
		state: RuntimeState,
		text: string,
		onDelta: (delta: string) => void,
		asNativeSlash: boolean = true,
		routeSource?: string,
	): Promise<void> {
		const service = state.runtime.messageService;
		if (!service) {
			throw new Error(
				"Agent runtime has no messageService — check that @elizaos/plugin-sql initialised correctly.",
			);
		}
		// Resolve per-source room/entity. Chat UI and unspecified sources
		// use the default ROOM_ID/USER_ID. Eval, cron, conversationId each
		// get their own room so ElizaOS's handleMessage processes them
		// concurrently (latestResponseIds is keyed per agentId+roomId).
		const activeRoomId = roomForSource(routeSource);
		const activeEntityId = entityForSource(routeSource);
		const sourceLabel = routeSource ?? "tray-app";
		// ensureConnection.channelId accepts any string — use the source for routing.
		// gateway.recordChatReply.channel is a typed GatewayChannel union — always "chat"
		// since all messages through this path originate from the tray-app chat surface.
		const channelId = routeSource ?? "chat";
		const gatewayChannel = "chat" as const;
		// Ensure the entity/room/world exist before posting the memory —
		// eliza's messageService drops messages whose room isn't registered.
		// Mirror the inbox path's ensureConnection call exactly, including
		// type as the literal string "DM".
		try {
			await state.runtime.ensureConnection({
				entityId: activeEntityId,
				roomId: activeRoomId,
				worldId: WORLD_ID,
				userName: routeSource ? `User:${routeSource}` : "User",
				source: sourceLabel,
				channelId: channelId,
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
			entityId: activeEntityId,
			agentId: state.runtime.agentId,
			roomId: activeRoomId,
			content: { text, source: sourceLabel, attachments: [] },
			createdAt: Date.now(),
		};
		// asNativeSlash=false means the caller already rendered a
		// skill-derived prompt — skip slash detection and run the
		// text through the LLM as a regular chat input.
		const slash = asNativeSlash ? nativeSlashCommand(text) : null;
		if (slash && slash.kind === "prompt") {
			// Substitute the rendered skill prompt for the user's
			// `/skill foo bar` and fall through to the LLM pipeline
			// below. message.content.text gets re-set to the prompt
			// so the agent sees the expanded request.
			text = slash.text;
			(message.content as { text: string }).text = slash.text;
		} else if (slash) {
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
					roomId: String(activeRoomId),
					entityId: String(state.runtime.agentId),
					channel: gatewayChannel,
					source: sourceLabel,
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
				roomId: String(activeRoomId),
				entityId: String(state.runtime.agentId),
				channel: gatewayChannel,
				source: sourceLabel,
			});
		}
	}

	/**
	 * Build a live runtime for the user's chosen provider.
	 *
	 * Walks the active provider's credential variants (e.g. Codex OAuth
	 * then OPENAI_API_KEY for `openai`, or multiple OAuth accounts).
	 * After all active-provider credentials are exhausted (either uninit-
	 * failed OR currently quota-capped + blockedAttemptIds includes them),
	 * walks the user-configured fallback chain in the order they set.
	 *
	 * - Returns `null` when no provider is selected (or no provider has
	 *   any usable credential). Callers surface "No LLM provider
	 *   configured" in the UI.
	 * - Throws when there are credentials but they all failed to init.
	 *   The error names the active provider so the user knows what to fix.
	 *
	 * `blockedAttemptIds` is consulted only for cap-driven rebuilds — the
	 * caller passes the set of credential ids we already know are rate-
	 * capped on `ProviderQuotaService`, so we don't pick them again this
	 * pass. Empty set = first-build / normal rebuild.
	 */
	private async build(
		blockedAttemptIds: ReadonlySet<string> = new Set(),
	): Promise<RuntimeState | null> {
		await this.vault.loadKeysIntoEnv();
		const allAttempts = await this.providerAttempts();
		const attempts = allAttempts.filter((a) => !blockedAttemptIds.has(a.id));
		if (attempts.length === 0) {
			if (allAttempts.length === 0) return null;
			throw new Error(
				`All configured credentials are rate-capped right now (${allAttempts.length} blocked). ` +
				`Wait for a cap to reset, add another provider key in Settings → Providers, ` +
				`or extend the fallback order.`,
			);
		}
		const activeProvider = attempts[0]!.providerId;
		const errors: string[] = [];
		for (const attempt of attempts) {
			try {
				return await this.buildAttempt(attempt);
			} catch (err) {
				errors.push(`${attempt.label}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		throw new Error(
			`Active provider '${activeProvider}' failed: ${errors.join(" | ")}. ` +
			`Reconnect in Settings → Providers, or pick a different provider.`,
		);
	}

	private async buildAttempt(
		attempt: ProviderAttempt,
		options: BuildAttemptOptions = { channels: true },
	): Promise<RuntimeState> {
		await attempt.prepare();
		const llmPlugins = await this.llmPluginsForAttempt(attempt);
		// Emit the active-vs-recovery LLM plugin layout once per build so
		// "the agent is using OpenRouter when I picked Claude" bugs are
		// answerable from logs alone. Pairs with the priority assignment
		// in `llmPluginsForAttempt`.
		logger.info(
			{ src: "runtime", active: `${attempt.providerId}/${attempt.runtimeProvider}`, plugins: llmPlugins.map((p) => `${p.name}@${p.priority ?? 0}`).join(", ") },
			"LLM plugin layout for build",
		);
		const character = await this.buildCharacter();
		const channelResolved = options.channels
			? await this.resolveChannelPlugins()
			: { plugins: [], settings: {} as Record<string, string> };
		const settings = await this.buildRuntimeSettings(channelResolved.settings);
		this.mergeEmbeddingSettingsIntoCharacter(character, settings);
		this.mergeMcpSettingsIntoCharacter(character);
		const runtime = new AgentRuntime({
			character,
			plugins: this.basePlugins(llmPlugins),
			enableAutonomy: true,
			settings,
		});
		try {
			await runtime.initialize();
			installDiscordMentionAliasPatch(runtime);
			// Install in this exact order: freeform planner FIRST, then
			// dpe-fallback. Freeform intercepts reply-like schemas and
			// runs a plain-prompt planner; if it returns null, dpe-
			// fallback's compact retry + plain-text reply chain takes
			// over. Reversed order = dpe-fallback never sees the call.
			installFreeformPlannerPatch(runtime);
			installDpeFallbackPatch(runtime);
			await this.provisionRuntime(runtime);
			if (options.channels) {
				// Boot-critical chat connection — chat path needs this.
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
				// Lazy: every external-channel wiring runs in the
				// background after warm. The agent answers chat turns
				// immediately; Discord / Telegram / iMessage attach
				// 200-2000ms later without blocking startup.
				//
				// Order matters here too: owner-bind must complete
				// before channel plugins register (they consult the
				// bound owner during init), so we await sequentially
				// but in a detached Task so cold-start isn't gated.
				void (async () => {
					try {
						await this.waitForOwnerBind(runtime);
						await this.registerChannelPlugins(runtime, channelResolved.plugins);
						installDiscordMessageManagerGuard(runtime);
						this.wirePairingCommands(runtime);
						this.scheduleDiscordCatchUp(runtime);
						logger.info({ src: "runtime", plugins: channelResolved.plugins.map((p) => p.name).join(", ") || "(none)" }, "channel plugins attached (lazy)");
					} catch (err) {
						logger.warn({ src: "runtime" }, " lazy channel plugin attach failed:", err instanceof Error ? err.message : err);
					}
				})();
			}

			this.wireOrchestratorBridges(runtime);

			return {
				runtime,
				provider: attempt.runtimeProvider,
				providerId: attempt.providerId,
				attemptId: attempt.id,
			};
		} catch (err) {
			await runtime.stop().catch(() => {});
			throw err;
		}
	}

	/**
	 * Hook the orchestrator's swarm coordinator into detour's plumbing.
	 *
	 * - chatCallback: coordinator emits "task-agent says X". If the task was
	 *   spawned in response to a Telegram/Discord/X/iMessage/etc thread,
	 *   the routing helper sends X back to that thread. Otherwise we drop X into the
	 *   in-app chat via gateway.recordChatReply + chatDelta broadcast so
	 *   the user sees the task progress in the chat panel they spawned it
	 *   from.
	 * - wsBroadcast: PTY session events go out as `ptySessionEvent` so the
	 *   Tasks panel can render live status.
	 * - swarmCompleteCallback: when all tasks in a swarm finish, route the
	 *   synthesized summary the same way as chat callback.
	 *
	 * No-ops cleanly when the orchestrator plugin failed to load (PTY_SERVICE
	 * absent → coordinator absent → early return).
	 */
	private wireOrchestratorBridges(runtime: AgentRuntime): void {
		try {
			const ptyService = runtime.getService("PTY_SERVICE") as
				| { coordinator?: import("./orchestrator-types").OrchestratorCoordinator }
				| null;
			const coordinator = ptyService?.coordinator;
			if (!coordinator) return;

			type OrchRouting = import("./orchestrator-types").OrchestratorChatRouting;
			const routeOrFallback = async (text: string, source?: string, routing?: OrchRouting) => {
				try {
					const m = (await import("@elizaos/agent/api/task-agent-message-routing")) as {
						routeTaskAgentTextToConnector?: (
							rt: AgentRuntime,
							t: string,
							s: string,
							r?: OrchRouting,
						) => Promise<boolean>;
					};
					if (m.routeTaskAgentTextToConnector) {
						const delivered = await m.routeTaskAgentTextToConnector(runtime, text, source ?? "coding-agent", routing);
						if (delivered) return;
					}
				} catch {
					/* fall through to in-app chat */
				}
				if (this.gateway) {
					this.gateway.recordChatReply({
						text,
						roomId: String(ROOM_ID),
						entityId: String(runtime.agentId),
						channel: "chat",
						source: source ?? "coding-agent",
					});
				}
				broadcaster.broadcast("chatDelta", { convId: "default", delta: text, traceId: `task-agent:${source ?? "coding-agent"}` });
			};

			coordinator.setChatCallback?.((text, source, routing) => {
				void routeOrFallback(text, source, routing);
			});

			// Status relay — surfaces a handful of high-signal session
			// events (spawn, tool start, completion, failure, login prompt)
			// as `workerStatusUpdate` messages dressed with the spawned
			// worker's name ("Hungover Squirrel is using bash"). Tool
			// events are rate-limited per (sessionId, tool) to avoid
			// chat-spam during heavy edit runs. See worker-status-relay.ts.
			const ptyServiceForStatus = runtime.getService("PTY_SERVICE") as
				| { getSessionInfo?: (id: string) => { name?: string } | undefined }
				| undefined;
			const workerStatusRelay = createWorkerStatusRelay({
				lookupWorkerName: (id) => ptyServiceForStatus?.getSessionInfo?.(id)?.name,
			});

			coordinator.setWsBroadcast?.((event) => {
				const { type: eventType, ...rest } = event;
				// Enrich the existing low-level event with the worker name so
				// any consumer (chat UI, activity panel, tooling) gets the
				// readable handle for free.
				const sessionId = (rest as { sessionId?: string }).sessionId;
				const workerName = sessionId
					? ptyServiceForStatus?.getSessionInfo?.(sessionId)?.name
					: undefined;
				broadcaster.broadcast("ptySessionEvent", { eventType, ...rest, workerName });
				// Surface a chat-friendly status ping for moments worth
				// narrating. Returns null for noisy/internal events.
				const status = typeof eventType === "string"
					? workerStatusRelay.relay({ type: eventType, ...(rest as Record<string, unknown>) })
					: null;
				if (status) {
					broadcaster.broadcast("workerStatusUpdate", status);
				}
			});

			coordinator.setSwarmCompleteCallback?.(async (payload) => {
				const summary = payload.tasks
					.map((t) => `• ${t.label} (${t.status}): ${t.completionSummary}`)
					.join("\n");
				const text = `Swarm complete (${payload.completed}/${payload.total} tasks)\n${summary}`;
				await routeOrFallback(text, "swarm-coordinator");
			});

			logger.info({ src: "runtime" }, " orchestrator bridges wired (chat + ws + swarm-complete)");
		} catch (err) {
			logger.warn({ src: "runtime" }, " orchestrator bridge wiring failed:", err instanceof Error ? err.message : err);
		}
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
			logger.info({ src: "runtime", count: resolved.plugins.length, plugins: resolved.plugins.map((p) => p.name).join(", ") }, "loading channel plugins");
		}
		return resolved;
	}

	private async buildRuntimeSettings(channelSettings: Record<string, string>): Promise<Record<string, string>> {
		const settings: Record<string, string> = {
			...channelSettings,
			EMBEDDING_DIMENSION: resolveEmbeddingDimension(),
			OPENAI_EMBEDDING_DIMENSIONS: resolveEmbeddingDimension(),
			// Explicitly pass the embedding provider + local model settings so
			// that runtime.getSetting() returns them directly instead of falling
			// through to process.env — the elizaOS ModelConfigSchema Zod enum
			// rejects unknown values and the env-var lookup sometimes picks up
			// stale or mis-cased entries.
			...(process.env.EMBEDDING_PROVIDER ? { EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER } : {}),
			...(process.env.LOCAL_EMBEDDING_MODEL ? { LOCAL_EMBEDDING_MODEL: process.env.LOCAL_EMBEDDING_MODEL } : {}),
			...(process.env.LOCAL_EMBEDDING_DIMENSIONS ? { LOCAL_EMBEDDING_DIMENSIONS: process.env.LOCAL_EMBEDDING_DIMENSIONS } : {}),
			// Extra providers pulled into the first-pass response state on
			// every chat turn. Eliza's `composeResponseState` defaults to
			// just CORE [ENTITIES, CHARACTER, RECENT_MESSAGES, ACTIONS,
			// PROVIDERS] with `onlyInclude=true`, so every Detour-specific
			// "always-on" provider (character anchor, capabilities, coding
			// brief, skill catalog, pensieve chronicler) gets silently
			// dropped from the prompt. Same for FACTS / RELATIONSHIPS,
			// which Eliza marks `dynamic: true` and expects the model to
			// request explicitly — that wastes a whole LLM round-trip for
			// a Pensieve-grounded agent where remembered facts and entity
			// relationships are first-class context, not optional follow-up.
			//
			// We surface them up-front so:
			//   - the agent sounds like itself across provider failover
			//     (CHARACTER_ANCHOR carries identity + tone),
			//   - "what can you do?" gets the live runtime snapshot
			//     (CAPABILITIES enumerates loaded plugins/actions),
			//   - "use the right tool" routes through the live brief
			//     (CODING_BRIEF + SKILL_CATALOG),
			//   - remembered facts and relationships feed every reply
			//     (FACTS, RELATIONSHIPS),
			//   - recent user activity is in scope without asking
			//     (USER_ACTIVITY_CONTEXT from the Pensieve chronicler).
			//
			// Names not registered at runtime are ignored by composeState.
			ADDITIONAL_RESPONSE_STATE_PROVIDERS: [
				"AGENT_CHARACTER_ANCHOR",
				"DETOUR_ACTIVE_GOAL",
				"AGENT_CAPABILITIES",
				"AGENT_CODING_BRIEF",
				"DESKTOP_USE_STATUS",
				"MEDIA_GENERATION_STATUS",
				"AUDIO_GENERATION_STATUS",
				"AGENT_SKILL_CATALOG",
				"USER_ACTIVITY_CONTEXT",
				"CONTACT_DOSSIER",
				"FACTS",
				"RELATIONSHIPS",
			].join(","),
		};
		if (
			settings.VALIDATION_LEVEL === undefined &&
			process.env.VALIDATION_LEVEL === undefined
		) {
			settings.VALIDATION_LEVEL = "progressive";
		}
		settings.DISCORD_AUTO_REPLY ??= "true";
		settings.TELEGRAM_AUTO_REPLY ??= "true";
		settings.DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS ??= "false";
		// elizaOS: `lifeOpsPassiveConnectorsEnabled()` is true when
		// ELIZA_LIFEOPS_PASSIVE_CONNECTORS / LIFEOPS_PASSIVE_CONNECTORS are unset.
		// Plugin-telegram then forces ingest-only (no auto-reply) even when
		// TELEGRAM_AUTO_REPLY is true. Detour is an interactive tray agent, not a
		// lifeops ingest worker — default to active connectors unless env explicitly opts in.
		if (
			settings.ELIZA_LIFEOPS_PASSIVE_CONNECTORS === undefined &&
			settings.LIFEOPS_PASSIVE_CONNECTORS === undefined &&
			process.env.ELIZA_LIFEOPS_PASSIVE_CONNECTORS === undefined &&
			process.env.LIFEOPS_PASSIVE_CONNECTORS === undefined
		) {
			settings.ELIZA_LIFEOPS_PASSIVE_CONNECTORS = "false";
		}
		// Per-agent sandbox dir for plugin-coding-tools. The plugin itself
		// is blocklist-based (denies user-private + system paths) and
		// otherwise allows any absolute path; the agent reads this setting
		// to know where to default new files when the user says "save it"
		// or "make a new project". Pre-created at boot in
		// src/bun/core/index.ts so the path always exists.
		settings.DETOUR_AGENT_SANDBOX ??= join(homedir(), ".detour", "agent-sandbox");
		// Forward to env so plugin actions that read process.env
		// (e.g. CLOUD_LIST_APPS / CLOUD_CREATE_APP) pick up the same value.
		process.env.DETOUR_AGENT_SANDBOX = settings.DETOUR_AGENT_SANDBOX;
		// Elevated-coding flag: persisted in AgentConfig, mirrored to env
		// by ConfigService.applyAgent. We carry it into runtime settings
		// here so providers reading via runtime.getSetting() see it
		// regardless of process.env state.
		try {
			const agentCfg = this.config ? await this.config.getAgent() : null;
			if (agentCfg?.elevatedCoding) {
				settings.DETOUR_ELEVATED_CODING = "true";
				process.env.DETOUR_ELEVATED_CODING = "true";
			} else {
				delete settings.DETOUR_ELEVATED_CODING;
				delete process.env.DETOUR_ELEVATED_CODING;
			}
		} catch { /* config service unavailable — leave flag unset */ }
		// Forward the stored ElizaCloud key so plugin-cloud-apps actions
		// can authenticate without an extra round-trip through the vault
		// service. setProviderKey already mirrors into process.env when
		// the key is set/rotated.
		const cloudKey = process.env.ELIZAOS_CLOUD_API_KEY;
		if (cloudKey) settings.ELIZAOS_CLOUD_API_KEY = cloudKey;
		this.loadEmbeddingSettings(settings);
		await this.loadXSettings(settings);
		await this.loadAudioSettings(settings);
		await this.loadMediaGenerationSettings(settings);
		return settings;
	}

	private loadEmbeddingSettings(settings: Record<string, string>): void {
		// Always overwrite with env-var values when present. The previous guard
		// (`&& !settings.OPENAI_EMBEDDING_URL`) let a stale or partially
		// initialized settings object win over the freshly resolved local
		// llama-server URL, sending embedding requests to api.openai.com /
		// OpenRouter even though llama was up and listening locally.
		const llamaUrl = process.env.OPENAI_EMBEDDING_URL;
		if (typeof llamaUrl === "string" && llamaUrl.length > 0) {
			settings.OPENAI_EMBEDDING_URL = llamaUrl;
		}
		if (process.env.OPENAI_EMBEDDING_API_KEY) {
			settings.OPENAI_EMBEDDING_API_KEY = process.env.OPENAI_EMBEDDING_API_KEY;
		}
		if (process.env.OPENAI_EMBEDDING_MODEL) {
			settings.OPENAI_EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL;
		}
		if (process.env.OPENAI_EMBEDDING_DIMENSIONS) {
			settings.OPENAI_EMBEDDING_DIMENSIONS = process.env.OPENAI_EMBEDDING_DIMENSIONS;
		}
	}

	/** Keys mirrored onto `character.settings` so they override DB-persisted agent settings.
	 *
	 * Eliza `getSetting()` resolves `character.settings` before constructor `settings`
	 * (`this.settings`). After `initialize()`, the DB merge is `{ ...db, ...character }`,
	 * so values we place on the initial character still win over stale `OPENAI_EMBEDDING_*`
	 * rows in the agent row — which otherwise pointed the embedding plugin at the cloud
	 * even when `startCore` had set `process.env` for local llama-server. */
	private static readonly EMBEDDING_SETTING_KEYS = EMBEDDING_RUNTIME_SETTING_KEYS;

	private mergeEmbeddingSettingsIntoCharacter(character: Character, settings: Record<string, string>): void {
		// Merge the standard embedding keys plus EMBEDDING_PROVIDER itself —
		// the EMBEDDING_RUNTIME_SETTING_KEYS only list the OPENAI_EMBEDDING_*
		// keys but validateModelConfig also reads EMBEDDING_PROVIDER from
		// getSetting() which checks character.settings BEFORE this.settings.
		const EXTRA_EMBED_KEYS = ["EMBEDDING_PROVIDER", "LOCAL_EMBEDDING_MODEL", "LOCAL_EMBEDDING_DIMENSIONS"] as const;
		// Also merge X cookies and iMessage enable flag so they win over
		// stale/encrypted values persisted in the DB agent row.
		const CRITICAL_VAULT_KEYS = ["X_AUTH_TOKEN", "X_CT0", "X_USER_AGENT", "X_AUTONOMY_ENABLED", "IMESSAGE_ENABLED"] as const;
		const base =
			character.settings && typeof character.settings === "object" && !Array.isArray(character.settings)
				? { ...character.settings }
				: {};
		for (const key of RuntimeService.EMBEDDING_SETTING_KEYS) {
			const v = settings[key];
			if (typeof v === "string" && v.length > 0) {
				(base as Record<string, string>)[key] = v;
			}
		}
		for (const key of EXTRA_EMBED_KEYS) {
			const v = settings[key] ?? process.env[key];
			if (typeof v === "string" && v.length > 0) {
				(base as Record<string, string>)[key] = v;
			}
		}
		for (const key of CRITICAL_VAULT_KEYS) {
			const v = settings[key];
			if (typeof v === "string" && v.length > 0) {
				(base as Record<string, string>)[key] = v;
			}
		}
		character.settings = base;
	}

	/**
	 * Pipe the MCP server config (env/vault `MCP_SERVERS`, a JSON string) into
	 * `character.settings.mcp` as an object, which is where plugin-mcp's
	 * `McpService` looks (`getSetting("mcp")` expects an object, not a string,
	 * and Detour's runtime settings are all strings). Accepts either the full
	 * `{ "servers": { … } }` shape or just the bare servers map. No-ops when
	 * unset or invalid JSON so the MCP plugin (registered only when MCP_SERVERS
	 * is present) simply has no servers.
	 */
	private mergeMcpSettingsIntoCharacter(character: Character): void {
		const raw = process.env.MCP_SERVERS;
		if (!raw) return;
		try {
			const parsed = JSON.parse(raw) as unknown;
			const servers =
				parsed && typeof parsed === "object" && !Array.isArray(parsed) && "servers" in parsed
					? (parsed as { servers: unknown }).servers
					: parsed;
			if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
				logger.warn({ src: "runtime" }, "MCP_SERVERS has no usable `servers` object — MCP plugin will have no servers");
				return;
			}
			const base =
				character.settings && typeof character.settings === "object" && !Array.isArray(character.settings)
					? { ...character.settings }
					: {};
			(base as Record<string, unknown>).mcp = { servers };
			character.settings = base;
		} catch (err) {
			logger.warn(
				{ src: "runtime", err: err instanceof Error ? err.message : err },
				"MCP_SERVERS is not valid JSON — MCP plugin will have no servers",
			);
		}
	}

	private async loadXSettings(settings: Record<string, string>): Promise<void> {
		try {
			const v = await this.vault.vault();
			for (const key of X_RUNTIME_SETTING_KEYS) {
				if (await v.has(key)) {
					const val = await v.get(key);
					if (typeof val === "string" && val.length > 0) {
						settings[key] = val;
						process.env[key] = val;
					}
				}
			}
		} catch (err) {
			logger.warn({ src: "runtime" }, " x-creds load failed:", err instanceof Error ? err.message : err);
		}
		// When an X_CHROME_PROFILE is configured, the agent's X identity follows
		// that Chrome profile's logged-in x.com session — its cookies override any
		// vault X_AUTH_TOKEN/X_CT0 (which may belong to a different account).
		const chromeProfile = settings.X_CHROME_PROFILE ?? process.env.X_CHROME_PROFILE;
		if (chromeProfile) {
			const chromeCookies = readChromeXCookies(chromeProfile);
			if (chromeCookies) {
				settings.X_AUTH_TOKEN = chromeCookies.authToken;
				process.env.X_AUTH_TOKEN = chromeCookies.authToken;
				settings.X_CT0 = chromeCookies.ct0;
				process.env.X_CT0 = chromeCookies.ct0;
				logger.info({ src: "runtime", profile: chromeProfile }, "X cookies sourced from Chrome profile");
			} else {
				logger.warn(
					{ src: "runtime", profile: chromeProfile },
					"X_CHROME_PROFILE set but Chrome cookie read failed — falling back to vault X cookies",
				);
			}
		}
	}

	private async loadAudioSettings(settings: Record<string, string>): Promise<void> {
		try {
			const v = await this.vault.vault();
			for (const key of AUDIO_RUNTIME_SETTING_KEYS) {
				if (await v.has(key)) {
					const val = await v.get(key);
					if (typeof val === "string" && val.length > 0) {
						settings[key] = val;
						process.env[key] = val;
					}
				}
			}
		} catch (err) {
			logger.warn({ src: "runtime" }, " audio settings load failed:", err instanceof Error ? err.message : err);
		}
	}

	private async loadMediaGenerationSettings(settings: Record<string, string>): Promise<void> {
		try {
			const v = await this.vault.vault();
			for (const key of MEDIA_GENERATION_SETTING_KEYS) {
				if (await v.has(key)) {
					const val = await v.get(key);
					if (typeof val === "string" && val.length > 0) {
						settings[key] = val;
						process.env[key] = val;
					}
				}
			}
		} catch (err) {
			logger.warn({ src: "runtime" }, " media generation settings load failed:", err instanceof Error ? err.message : err);
		}
	}

	private async llmPluginsForAttempt(attempt: ProviderAttempt): Promise<Plugin[]> {
		const directKeys = {
			openai: await this.providerApiKey("openai", "OPENAI_API_KEY"),
			anthropic: await this.providerApiKey("anthropic", "ANTHROPIC_API_KEY"),
			openrouter: await this.providerApiKey("openrouter", "OPENROUTER_API_KEY"),
			elizacloud: await this.providerApiKey("elizacloud", "ELIZAOS_CLOUD_API_KEY"),
		};
		const providers: RuntimeProvider[] = [attempt.runtimeProvider];
		const push = (provider: RuntimeProvider, key: string | null) => {
			if (!key || providers.includes(provider)) return;
			providers.push(provider);
		};
		push("openrouter", directKeys.openrouter);
		push("elizacloud", directKeys.elizacloud);
		push("anthropic", directKeys.anthropic);
		push("openai", directKeys.openai);
		const loaded = await Promise.all(providers.map((provider) => PROVIDER_PLUGINS[provider]()));
		return tagLlmPluginPriorities(loaded);
	}

	private basePlugins(llmPlugins: Plugin[]): Plugin[] {
		return [
			sqlPlugin,
			...llmPlugins,
			embeddingOpenAIPlugin,
			localChatPlugin,
			// dev-only: when DETOUR_DEV_INFERENCE=1 it wins text routing at
			// priority 150; otherwise inert. Text-only — embeddings stay put.
			devInferencePlugin,
			embeddingStubPlugin,
			vaultToolsPlugin,
			pensieveToolsPlugin,
			contactDossierPlugin,
			codingToolsPlugin,
			// Web search (Tavily) — fast factual lookups via the SEARCH "web"
			// category. Off unless TAVILY_API_KEY is set (its service throws
			// without one).
			...(process.env.TAVILY_API_KEY ? [webSearchPlugin] : []),
			// MCP client — agent gains tools from configured MCP servers.
			// Off unless MCP_SERVERS is set; the JSON is piped into
			// character.settings.mcp by mergeMcpSettingsIntoCharacter.
			...(process.env.MCP_SERVERS ? [mcpPlugin] : []),
			codexPetsPlugin,
			codexSkillsPlugin,
			discordMentionAliasPlugin,
			discordContextPlugin,
			dpeFallbackPlugin,
			xTweetsPlugin,
			cloudAppsPlugin,
			agentProjectsPlugin,
			capabilitiesPlugin,
			detourGoalPlugin,
			detourDiscordMediaPlugin,
			detourTelegramMediaPlugin,
			detourIMessageMediaPlugin,
			portlessToolsPlugin,
			agentSkillsPlugin,
			agentPublicLogPlugin,
			trajectoryLessonsPlugin,
			openQuestionsPlugin,
			phantomWalletToolsPlugin,
			gmgnToolsPlugin,
			audioGenerationPlugin,
			mediaGenerationPlugin,
			modelRouterPlugin,    // priority 1000 — enforces user routing pref across all types
			desktopControlPlugin,
			macAutomatePlugin,
			...(agentOrchestratorPlugin ? [agentOrchestratorPlugin] : []),
			// cronToolsPlugin: replaced by `cron-tools` carrot loaded via the
			// carrot bridge — see core/index.ts and src/bun/core/carrots/. The
			// carrot worker.ts mirrors the static plugin's actions, but runs
			// isolated and reaches CronService over RPC.
			...this.extraPlugins,
			...(this.ownerBind ? [makeOwnerBindPlugin(this.ownerBind)] : []),
		];
	}

	private async waitForOwnerBind(runtime: AgentRuntime): Promise<void> {
		if (!this.ownerBind) return;
		try {
			await runtime.getServiceLoadPromise("OWNER_BIND_VERIFY");
			logger.info({ src: "runtime" }, " OWNER_BIND_VERIFY started — channel plugins safe to load");
		} catch (err) {
			logger.warn({ src: "runtime" }, " OWNER_BIND_VERIFY start failed:", err instanceof Error ? err.message : err);
		}
	}

	private async registerChannelPlugins(runtime: AgentRuntime, plugins: Plugin[]): Promise<void> {
		for (const channelPlugin of plugins) {
			try {
				await runtime.registerPlugin(channelPlugin);
			} catch (err) {
				logger.warn({ src: "runtime", plugin: channelPlugin.name, err: err instanceof Error ? err.message : err }, "failed to register channel plugin");
			}
		}
	}

	private wirePairingCommands(runtime: AgentRuntime): void {
		void this.wireTelegramPairCommand(runtime).catch((err) =>
			logger.warn({ src: "runtime" }, " /eliza_pair wire failed:", err instanceof Error ? err.message : err),
		);
		void this.wireDiscordPairCommand(runtime).catch((err) =>
			logger.warn({ src: "runtime" }, " /eliza-pair wire failed:", err instanceof Error ? err.message : err),
		);
	}

	private async provisionRuntime(runtime: AgentRuntime): Promise<void> {
		try {
			await provisionAgent(runtime, { runMigrations: false });
		} catch (err) {
			logger.warn({ src: "runtime" }, " provisionAgent failed:", err instanceof Error ? err.message : err);
		}
	}

	private startTaskServiceTimer(runtime: AgentRuntime): void {
		try {
			const taskSvc = runtime.getService("task") as { startTimer?: () => void; markDirty?: () => void } | null;
			taskSvc?.startTimer?.();
			if (taskSvc?.markDirty) {
				this.markDirtyInterval = setInterval(() => taskSvc.markDirty?.(), TASK_DIRTY_PUMP_INTERVAL_MS);
				(this.markDirtyInterval as unknown as { unref?: () => void }).unref?.();
			}
			logger.info({ src: "runtime" }, "task service timer started");
		} catch (err) {
			logger.warn({ src: "runtime", err: err instanceof Error ? err.message : err }, "task timer start failed");
		}
	}

	private scheduleDiscordCatchUp(runtime: AgentRuntime): void {
		const enabled = String(runtime.getSetting("DISCORD_CATCH_UP_ENABLED") ?? "true").toLowerCase();
		if (enabled === "false" || enabled === "0" || enabled === "off") return;
		const timer = setTimeout(() => {
			void runDiscordCatchUp(runtime, {
				limit: 100,
				maxAgeMs: 6 * 60 * 60_000,
			}).catch((err) => {
				runtime.logger.warn(
					{
						src: "runtime",
						error: err instanceof Error ? err.message : String(err),
					},
					"Discord catch-up failed",
				);
			});
		}, 5_000);
		(timer as { unref?: () => void }).unref?.();
	}

	private async providerAttempts(): Promise<ProviderAttempt[]> {
		const order = await this.providerOrder();
		const attempts: ProviderAttempt[] = [];
		const directKeys = {
			openai: await this.providerApiKey("openai", "OPENAI_API_KEY"),
			anthropic: await this.providerApiKey("anthropic", "ANTHROPIC_API_KEY"),
			openrouter: await this.providerApiKey("openrouter", "OPENROUTER_API_KEY"),
			elizacloud: await this.providerApiKey("elizacloud", "ELIZAOS_CLOUD_API_KEY"),
		};
		logger.info({ src: "runtime", order, openai: !!directKeys.openai, anthropic: !!directKeys.anthropic, openrouter: !!directKeys.openrouter, elizacloud: !!directKeys.elizacloud }, "provider order resolved");
		const pushFor = async (provider: ProviderId): Promise<void> => {
			if (provider === "openai") attempts.push(...await this.openAiAttempts(directKeys.openai));
			else if (provider === "anthropic") attempts.push(...this.anthropicAttempts(directKeys.anthropic));
			else if (provider === "openrouter" && directKeys.openrouter) {
				attempts.push(this.apiAttempt("openrouter", "openrouter", "OPENROUTER_API_KEY", directKeys.openrouter, "OpenRouter API key"));
			} else if (provider === "elizacloud" && directKeys.elizacloud) {
				attempts.push(this.apiAttempt("elizacloud", "elizacloud", "ELIZAOS_CLOUD_API_KEY", directKeys.elizacloud, "ElizaOS Cloud API key"));
			}
		};
		for (const provider of order) await pushFor(provider);

		// Hard fallback: if the active provider + user-configured fallback
		// chain produced zero usable attempts (e.g. only-Anthropic configured
		// + OAuth token expired + no refresh), try every other provider that
		// has a direct API key available. The user almost always prefers a
		// working agent over a strict no-attempts failure. Surfaces in the
		// log so the user sees which credential was actually used.
		if (attempts.length === 0) {
			const tried = new Set<ProviderId>(order);
			// ElizaCloud first — typically paid subscription, less rate-limited
			// than OpenRouter's free tier. Then OpenRouter, then direct API
			// keys for anthropic/openai if the user keyed one in directly.
			const directOrder: ProviderId[] = ["elizacloud", "openrouter", "anthropic", "openai"];
			for (const p of directOrder) {
				if (tried.has(p)) continue;
				if (p === "openrouter" && !directKeys.openrouter) continue;
				if (p === "elizacloud" && !directKeys.elizacloud) continue;
				if (p === "anthropic" && !directKeys.anthropic) continue;
				if (p === "openai" && !directKeys.openai) continue;
				logger.info(
					{ src: "runtime", fallbackProvider: p },
					"active provider chain produced no usable attempts; falling back to direct API key",
				);
				await pushFor(p);
				if (attempts.length > 0) break;
			}
		}
		return attempts;
	}

	/**
	 * The active provider plus any user-configured fallback chain.
	 *
	 * The active provider is always first — that's the user's primary
	 * choice and we won't silently bypass it. After that, the runtime
	 * walks the user-configured `trayapp.providerFallbackOrder` list
	 * (Settings → Providers), in order, when:
	 *
	 *   - the active provider has zero usable credentials at build time, OR
	 *   - the active credential is currently rate-capped (`usage_limit_reached`
	 *     recorded on `ProviderQuotaService`), AND `sendMessage` is rebuilding
	 *     to walk past the cap.
	 *
	 * The fallback is EXPLICIT — the user sets the order themselves, sees
	 * it in Settings, and sees a banner when a rotation happens. fb54849b's
	 * intent of "no silent walks behind the user's back" is preserved: the
	 * walk is user-configured, surfaced, and only fires on the specific
	 * quota-cap case (not on transient 429s, not on 503s, not on timeouts).
	 *
	 * Within each provider, multiple credentials (OAuth accounts + vault
	 * API key) are walked by `openAiAttempts` / `anthropicAttempts` etc.
	 */
	private async providerOrder(): Promise<ProviderId[]> {
		let activeProvider = await this.vault.getActiveProvider();
		if (!activeProvider) {
			// vault.activeProvider is only auto-set when the user adds an API
			// key via setProviderKey(). OAuth-paired accounts (anthropic
			// subscription, openai codex) don't go through that path — they're
			// added to @elizaos/agent/auth's account store directly. So a user
			// who paired OAuth + never typed an API key ends up with usable
			// credentials in `listAccounts()` and no active marker, and the
			// runtime previously refused to build despite having a path
			// forward. Auto-select the first provider that has any
			// discoverable credential (OAuth > API key) so the runtime boots.
			activeProvider = await this.autoSelectActiveProviderFromAccounts();
			if (!activeProvider) return [];
			logger.info(
				{ src: "runtime", autoSelected: activeProvider },
				"no active provider set in vault; auto-selected from discovered OAuth/API credentials",
			);
		}
		const fallback = await this.vault.getProviderFallbackOrder();
		const seen = new Set<ProviderId>([activeProvider]);
		const order: ProviderId[] = [activeProvider];
		for (const id of fallback) {
			if (seen.has(id)) continue;
			seen.add(id);
			order.push(id);
		}
		return order;
	}

	/**
	 * Fallback discovery when the vault has no `trayapp.activeProvider`
	 * marker. Preference order: OAuth subscriptions first (richer context,
	 * usually pre-paid), then API keys (env-resolved or vault-stored). This
	 * is BUILD-time only — does not persist into the vault, so the user can
	 * still pin a different provider in Settings → Providers.
	 */
	private async autoSelectActiveProviderFromAccounts(): Promise<ProviderId | null> {
		const has = (kind: string): boolean => {
			try {
				const rows = listAccounts(kind as never) as AccountCredentialRecord[];
				return Array.isArray(rows) && rows.length > 0;
			} catch {
				return false;
			}
		};
		if (has("anthropic-subscription")) return "anthropic";
		if (has("openai-codex")) return "openai";
		// File-based Codex CLI auth (~/.codex/auth.json) isn't in the
		// account store — check it explicitly so users who only have
		// Codex CLI configured can boot the runtime.
		if (await detectSystemCodexAuth()) return "openai";
		if (has("anthropic-api")) return "anthropic";
		if (has("openai-api")) return "openai";
		// API-key-only providers — check the vault / env directly.
		if (await this.providerApiKey("openrouter", "OPENROUTER_API_KEY")) return "openrouter";
		if (await this.providerApiKey("elizacloud", "ELIZAOS_CLOUD_API_KEY")) return "elizacloud";
		if (await this.providerApiKey("anthropic", "ANTHROPIC_API_KEY")) return "anthropic";
		if (await this.providerApiKey("openai", "OPENAI_API_KEY")) return "openai";
		return null;
	}

	private async providerApiKey(provider: ProviderId, envKey: string): Promise<string | null> {
		const stored = await this.vault.getProviderKey(provider);
		if (stored) return stored;
		const env = process.env[envKey];
		return typeof env === "string" && env.length > 0 ? env : null;
	}

	private apiAttempt(
		providerId: ProviderId,
		runtimeProvider: RuntimeProvider,
		envKey: string,
		key: string,
		label: string,
	): ProviderAttempt {
		return {
			id: `${providerId}:api`,
			label,
			providerId,
			runtimeProvider,
			prepare: () => {
				process.env[envKey] = key;
				if (providerId === "openai") {
					delete process.env.CODEX_OAUTH_TOKEN;
					delete process.env.CODEX_CHATGPT_ACCOUNT_ID;
				}
				if (providerId === "anthropic") {
					// Primary apikey path: ensure the plugin treats this key as
					// an x-api-key (not OAuth Bearer).
					process.env.ANTHROPIC_AUTH_MODE = "apikey";
					delete process.env.ANTHROPIC_OAUTH_TOKEN;
				}
			},
		};
	}

	private async openAiAttempts(apiKey: string | null): Promise<ProviderAttempt[]> {
		const attempts: ProviderAttempt[] = [];
		const systemCodex = await detectSystemCodexAuth();
		if (systemCodex) {
			attempts.push({
				id: "openai:oauth:system-codex",
				label: "OpenAI Codex OAuth",
				providerId: "openai",
				runtimeProvider: "codex-chatgpt",
				prepare: () => {
					process.env.CODEX_OAUTH_TOKEN = systemCodex.accessToken;
					process.env.CODEX_CHATGPT_ACCOUNT_ID = systemCodex.accountId;
					logger.debug({ src: "runtime", accountId: systemCodex.accountId.slice(0, 8) + "…" }, "using system Codex CLI auth");
				},
			});
		}
		try {
			const codexAccounts = listAccounts("openai-codex") as AccountCredentialRecord[];
			const usable = codexAccounts
				.filter((a) => typeof a.credentials?.access === "string" && a.credentials.access.length > 0)
				.filter((a) => {
					const exp = a.credentials?.expires;
					return typeof exp !== "number" || exp <= 0 || exp > Date.now();
				});
			for (const account of usable) {
				const token = account.credentials!.access;
				const claims = decodeCodexJwt(token);
				const acctId = claims?.chatgptAccountId ?? "";
				if (acctId) {
					attempts.push({
						id: `openai:oauth:${account.id}`,
						label: `OpenAI Codex OAuth (${account.label})`,
						providerId: "openai",
						runtimeProvider: "codex-chatgpt",
						prepare: () => {
							process.env.CODEX_OAUTH_TOKEN = token;
							process.env.CODEX_CHATGPT_ACCOUNT_ID = acctId;
							logger.debug({ src: "runtime", label: account.label, id: account.id.slice(0, 8) + "…" }, "using openai-codex account");
						},
					});
				} else {
					logger.warn({ src: "runtime", id: account.id.slice(0, 8) + "…" }, "codex token has no chatgpt_account_id claim");
				}
			}
		} catch (err) {
			logger.warn({ src: "runtime", err: err instanceof Error ? err.message : err }, "codex OAuth probe failed");
		}
		// Stacked OpenAI API-key accounts (multi-key) — each entry on the
		// `openai-api` table becomes its own attempt with a stable id, so
		// the rotation engine can mark just-one-of-them as capped without
		// nuking the entire provider.
		try {
			const apiAccounts = listAccounts("openai-api") as AccountCredentialRecord[];
			for (const account of apiAccounts) {
				const key = account.credentials?.access;
				if (typeof key !== "string" || key.length === 0) continue;
				attempts.push({
					id: `openai:api:${account.id}`,
					label: `OpenAI API key (${account.label})`,
					providerId: "openai",
					runtimeProvider: "openai",
					prepare: () => {
						process.env.OPENAI_API_KEY = key;
						delete process.env.CODEX_OAUTH_TOKEN;
						delete process.env.CODEX_CHATGPT_ACCOUNT_ID;
						logger.debug({ src: "runtime", label: account.label, id: account.id.slice(0, 8) + "…" }, "using openai-api account");
					},
				});
			}
		} catch (err) {
			logger.warn({ src: "runtime", err: err instanceof Error ? err.message : err }, "openai-api probe failed");
		}
		// Legacy single-slot OPENAI_API_KEY dedup block removed — no users
		// have keys in the old format.
		return attempts;
	}

	private anthropicAttempts(apiKey: string | null): ProviderAttempt[] {
		const attempts: ProviderAttempt[] = [];
		try {
			const anthropicAccounts = listAccounts("anthropic-subscription") as AccountCredentialRecord[];
			// Surface expired-OAuth state so user knows why a paired account
			// isn't being used. Previously this was silent — runtime just
			// said "no provider configured" with no breadcrumb. The actual
			// refresh attempt happens inside the `prepare` step (see below)
			// so it only fires when we're about to use the credential — not
			// on every build, and not for accounts the user isn't selecting.
			for (const a of anthropicAccounts) {
				const c = a.credentials as { access?: unknown; expires?: unknown; refresh?: unknown } | undefined;
				const exp = c?.expires;
				if (typeof exp === "number" && exp > 0 && exp <= Date.now()) {
					const refresh = typeof c?.refresh === "string" ? "(will attempt refresh on use)" : "(no refresh token — re-pair in Settings → Providers)";
					logger.info({ src: "runtime", label: a.label, id: a.id.slice(0, 8) + "…", expiredAt: new Date(exp).toISOString() }, `anthropic-subscription access token expired ${refresh}`);
				}
			}
			// Include expired-but-refreshable accounts. The prepare() step
			// refreshes them just before the runtime initializes, so the
			// access token in process.env is fresh by the time the LLM
			// plugin reads it.
			const usable = anthropicAccounts.filter((a) => {
				const c = a.credentials;
				if (typeof c?.access !== "string" || !c.access.startsWith("sk-ant-oat")) return false;
				const exp = c.expires;
				if (typeof exp !== "number" || exp <= 0) return true; // never expires
				if (exp > Date.now()) return true; // not expired yet
				// Expired — only usable if we have a refresh token to swap in
				return typeof (c as { refresh?: unknown }).refresh === "string" &&
					(c as { refresh: string }).refresh.length > 0;
			});
			for (const account of usable) {
				attempts.push({
					id: `anthropic:oauth:${account.id}`,
					label: `Anthropic OAuth (${account.label})`,
					providerId: "anthropic",
					runtimeProvider: "anthropic",
					prepare: async () => {
						// Refresh JIT if expired. Persist the new access token
						// back to disk so the next build doesn't re-refresh.
						const c = account.credentials as {
							access: string;
							expires?: number;
							refresh?: string;
						};
						let access = c.access;
						const exp = c.expires;
						const expired = typeof exp === "number" && exp > 0 && exp <= Date.now();
						if (expired && typeof c.refresh === "string" && c.refresh.length > 0) {
							let refreshTimer: ReturnType<typeof setTimeout> | undefined;
							try {
								const fresh = await Promise.race([
									refreshAnthropicToken(c.refresh),
									new Promise<never>((_, reject) => {
										refreshTimer = setTimeout(() => reject(new Error(
											`Anthropic OAuth refresh timed out after ${ANTHROPIC_REFRESH_TIMEOUT_MS / 1_000}s — skipping this credential`,
										)), ANTHROPIC_REFRESH_TIMEOUT_MS);
									}),
								]);
								access = fresh.access;
								const updated: AccountCredentialRecord = {
									...account,
									credentials: { ...c, ...fresh },
									updatedAt: Date.now(),
								};
								saveAccount(updated);
								logger.debug({ src: "runtime", label: account.label, id: account.id.slice(0, 8) + "…" }, "refreshed anthropic-subscription access token");
							} catch (err) {
								logger.warn(
									{ src: "runtime", label: account.label, err: err instanceof Error ? err.message : String(err) },
									"anthropic OAuth refresh failed — re-pair in Settings → Providers",
								);
								throw err;
							} finally {
								clearTimeout(refreshTimer);
							}
						}
						// Flip the plugin into OAuth mode. Critical: without this
						// `ANTHROPIC_AUTH_MODE`, the plugin defaults to "apikey" and
						// sends our `sk-ant-oat01-*` OAuth token as `x-api-key`,
						// which Anthropic rejects with 401. With "oauth", the
						// plugin uses Bearer + the account-pool fetch wrapper.
						process.env.ANTHROPIC_AUTH_MODE = "oauth";
						// Keep ANTHROPIC_API_KEY out of the way — the plugin's
						// `getApiKeyOrPlaceholder` returns "oauth-placeholder"
						// in oauth mode; we don't want a stale apikey-mode value
						// from a previous run leaking in.
						delete process.env.ANTHROPIC_API_KEY;
						process.env.ANTHROPIC_ACCOUNT_ID = account.id;
						// Voice the access token through too so any direct env
						// reader (legacy code paths, sub-agent spawns) still
						// gets a working token while the plugin uses Bearer.
						process.env.ANTHROPIC_OAUTH_TOKEN = access;
						logger.debug({ src: "runtime", label: account.label, id: account.id.slice(0, 8) + "…", authMode: "oauth" }, "using anthropic-subscription account");
					},
				});
			}
		} catch (err) {
			logger.warn({ src: "runtime", err: err instanceof Error ? err.message : err }, "anthropic OAuth probe failed");
		}
		// Stacked Anthropic API-key accounts (multi-key). Same pattern as
		// OpenAI above — each entry is its own attempt with a stable id
		// so cap rotation can target one key at a time.
		try {
			const apiAccounts = listAccounts("anthropic-api") as AccountCredentialRecord[];
			for (const account of apiAccounts) {
				const key = account.credentials?.access;
				if (typeof key !== "string" || key.length === 0) continue;
				attempts.push({
					id: `anthropic:api:${account.id}`,
					label: `Anthropic API key (${account.label})`,
					providerId: "anthropic",
					runtimeProvider: "anthropic",
					prepare: () => {
						// Flip back to apikey mode in case a prior attempt left
						// `ANTHROPIC_AUTH_MODE=oauth` in the env.
						process.env.ANTHROPIC_AUTH_MODE = "apikey";
						delete process.env.ANTHROPIC_OAUTH_TOKEN;
						process.env.ANTHROPIC_API_KEY = key;
						process.env.ANTHROPIC_ACCOUNT_ID = account.id;
						logger.debug({ src: "runtime", label: account.label, id: account.id.slice(0, 8) + "…" }, "using anthropic-api account");
					},
				});
			}
		} catch (err) {
			logger.warn({ src: "runtime", err: err instanceof Error ? err.message : err }, "anthropic-api probe failed");
		}
		return attempts;
	}
}
