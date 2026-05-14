import {
	AgentRuntime,
	type Action,
	ChannelType,
	type Character,
	type Content,
	createCharacter,
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
import type { AuthService } from "./auth";
import { listAccounts, saveAccount, refreshAnthropicToken, type AccountCredentialRecord } from "@elizaos/agent/auth";
import { embeddingStubPlugin } from "./embedding-stub-plugin";
// Note: plugin-local-embedding (eliza's bundled choice) drags in node-llama-cpp,
// transformers, and whisper — too heavy for our bundle and hangs startup.
// Until we ship a transformers.js-only local plugin, the OpenAI embeddings
// plugin handles real embeddings when the user has an OPENAI_EMBEDDING_API_KEY;
// otherwise embedding-stub keeps the runtime alive with zero vectors.
import { embeddingOpenAIPlugin } from "../plugins/embedding-openai/index";
import { decodeCodexJwt } from "../plugins/codex-chatgpt/index";
import { codexHatchAction, codexPetAction, codexPetsPlugin } from "../plugins/codex-pets/index";
import {
	codexSkillInvocationPrompt,
	codexSkillsListText,
	codexSkillsPlugin,
	findCodexSkill,
} from "./codex-skills";
import { pensieveToolsPlugin } from "../plugins/pensieve-tools/index";
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
import { phantomWalletToolsPlugin } from "../plugins/phantom-wallet-tools/index";
import { audioGenerationPlugin, audioSettingKeys } from "../plugins/audio-generation/index";
import { mediaGenerationPlugin, mediaGenerationSettingKeys } from "../plugins/media-generation/index";
import { computerScreenshotAction, desktopControlPlugin } from "../plugins/desktop-control/index";
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
								console.warn(
									`[runtime] orchestrator service ${target.serviceType ?? target.name ?? "?"} start failed (boot continuing without it):`,
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
	console.warn("[runtime] orchestrator plugin unavailable:", err instanceof Error ? err.message : err);
	agentOrchestratorPlugin = null;
}
import { broadcaster } from "./rpc/registry";
import { makeOwnerBindPlugin } from "./owner-bind";
import { discordMentionAliasPlugin, installDiscordMentionAliasPatch, installDiscordMessageManagerGuard } from "./discord-mention-alias-plugin";
import { discordContextPlugin } from "./discord-context-provider";
import { dpeFallbackPlugin, installDpeFallbackPatch } from "./dpe-fallback-plugin";
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
const X_RUNTIME_SETTING_KEYS = [
	"X_AUTH_TOKEN",
	"X_CT0",
	"X_USER_AGENT",
	"X_AUTONOMY_ENABLED",
	"X_AUTONOMY_WRITE",
	"X_AUTONOMY_POST_STATUS_ENABLED",
	"X_AUTONOMY_DISCOVERY_ENABLED",
	"X_AUTONOMY_PROACTIVE_ENGAGEMENT_ENABLED",
	"X_AUTONOMY_FOLLOW_ENABLED",
	"X_AUTONOMY_INTERVAL_MS",
	"X_AUTONOMY_STATUS_INTERVAL_MS",
	"X_AUTONOMY_DISCOVERY_INTERVAL_MS",
	"X_AUTONOMY_MAX_REPLIES_PER_TICK",
	"X_AUTONOMY_MAX_DISCOVERY_PER_TICK",
	"X_AUTONOMY_DISCOVERY_QUERIES",
] as const;

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
		// auth dep is currently sourced via the singleton listAccounts() helper;
		// keeping the constructor slot lets callers pass it for future scoping.
		_auth?: AuthService,
		private readonly channels?: import("./channels").ChannelsService,
		private gateway?: import("./channels/gateway").ChannelGatewayService,
		private readonly config?: ConfigService,
	) {
		void _auth;
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
				console.warn("[runtime] afterBuild hook failed:", err instanceof Error ? err.message : err);
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
		if (!this.current) return;
		try {
			await this.current.runtime.stop();
		} catch (err) {
			console.error("Failed to stop runtime cleanly:", err);
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
		if (activeCap) {
			const resetText = new Date(activeCap.resetsAtMs).toLocaleString();
			throw new Error(
				`${activeCap.accountLabel} cap reached (resets ${resetText}) and no uncapped fallback is configured. ` +
				`Switch active provider in Settings → Providers, add a fallback to the order, or wait for the cap to reset.`,
			);
		}
		const slashEarly = nativeSlashCommand(text);
		if (slashEarly?.kind === "prompt") {
			// Skill-rendered prompt: route through the regular chat
			// pipeline (LLM + tools) by replacing the user's text
			// and falling out of the slash branch.
			this.maybeCaptureGoal(slashEarly.text);
			await this.deliverMessage(state, slashEarly.text, onDelta, /* asNativeSlash */ false);
			return;
		}
		this.maybeCaptureGoal(text);
		await this.deliverMessage(state, text, onDelta);
	}

	/**
	 * Background goal extraction. Returns immediately so the chat pipeline
	 * never waits on the extraction LLM call. By the time the user's NEXT
	 * turn composes state, the goal will be persisted and the
	 * DETOUR_ACTIVE_GOAL provider will surface it. Losing the goal on turn
	 * 1 is acceptable; blocking the first reply by 2-5s while we extract
	 * is not. Failure is logged but never propagated.
	 */
	private maybeCaptureGoal(text: string): void {
		const service = this.goalService;
		if (!service) return;
		void service.ensureGoalForTurn(String(ROOM_ID), text).catch((err) => {
			console.warn(
				"[runtime] goal extraction failed:",
				err instanceof Error ? err.message : err,
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
			console.warn(
				"[runtime] cap-driven rebuild exhausted all attempts:",
				err instanceof Error ? err.message : err,
			);
			return state;
		}
	}

	private async deliverMessage(
		state: RuntimeState,
		text: string,
		onDelta: (delta: string) => void,
		asNativeSlash: boolean = true,
	): Promise<void> {
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
		const character = await this.buildCharacter();
		const channelResolved = options.channels
			? await this.resolveChannelPlugins()
			: { plugins: [], settings: {} as Record<string, string> };
		const settings = await this.buildRuntimeSettings(channelResolved.settings);
		this.mergeEmbeddingSettingsIntoCharacter(character, settings);
		const runtime = new AgentRuntime({
			character,
			plugins: this.basePlugins(llmPlugins),
			enableAutonomy: true,
			settings,
		});
		try {
			await runtime.initialize();
			installDiscordMentionAliasPatch(runtime);
			installDpeFallbackPatch(runtime);
			if (options.channels) {
				await this.waitForOwnerBind(runtime);
				await this.registerChannelPlugins(runtime, channelResolved.plugins);
				installDiscordMessageManagerGuard(runtime);
				this.wirePairingCommands(runtime);
			}
			await this.provisionRuntime(runtime);
			if (options.channels) {
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
				this.scheduleDiscordCatchUp(runtime);
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

			coordinator.setWsBroadcast?.((event) => {
				const { type: eventType, ...rest } = event;
				broadcaster.broadcast("ptySessionEvent", { eventType, ...rest });
			});

			coordinator.setSwarmCompleteCallback?.(async (payload) => {
				const summary = payload.tasks
					.map((t) => `• ${t.label} (${t.status}): ${t.completionSummary}`)
					.join("\n");
				const text = `Swarm complete (${payload.completed}/${payload.total} tasks)\n${summary}`;
				await routeOrFallback(text, "swarm-coordinator");
			});

			console.log("[runtime] orchestrator bridges wired (chat + ws + swarm-complete)");
		} catch (err) {
			console.warn("[runtime] orchestrator bridge wiring failed:", err instanceof Error ? err.message : err);
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
			console.log(`[runtime] loading ${resolved.plugins.length} channel plugin(s): ${resolved.plugins.map((p) => p.name).join(", ")}`);
		}
		return resolved;
	}

	private async buildRuntimeSettings(channelSettings: Record<string, string>): Promise<Record<string, string>> {
		const settings: Record<string, string> = {
			...channelSettings,
			EMBEDDING_DIMENSION: "384",
			OPENAI_EMBEDDING_DIMENSIONS: "384",
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
	private static readonly EMBEDDING_SETTING_KEYS = [
		"OPENAI_EMBEDDING_URL",
		"OPENAI_EMBEDDING_API_KEY",
		"OPENAI_EMBEDDING_MODEL",
		"OPENAI_EMBEDDING_DIMENSIONS",
		"OPENAI_EMBEDDING_MAX_CHARS",
	] as const;

	private mergeEmbeddingSettingsIntoCharacter(character: Character, settings: Record<string, string>): void {
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
		character.settings = base;
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
			console.warn("[runtime] x-creds load failed:", err instanceof Error ? err.message : err);
		}
	}

	private async loadAudioSettings(settings: Record<string, string>): Promise<void> {
		try {
			const v = await this.vault.vault();
			for (const key of audioSettingKeys()) {
				if (await v.has(key)) {
					const val = await v.get(key);
					if (typeof val === "string" && val.length > 0) {
						settings[key] = val;
						process.env[key] = val;
					}
				}
			}
		} catch (err) {
			console.warn("[runtime] audio settings load failed:", err instanceof Error ? err.message : err);
		}
	}

	private async loadMediaGenerationSettings(settings: Record<string, string>): Promise<void> {
		try {
			const v = await this.vault.vault();
			for (const key of mediaGenerationSettingKeys()) {
				if (await v.has(key)) {
					const val = await v.get(key);
					if (typeof val === "string" && val.length > 0) {
						settings[key] = val;
						process.env[key] = val;
					}
				}
			}
		} catch (err) {
			console.warn("[runtime] media generation settings load failed:", err instanceof Error ? err.message : err);
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
		return await Promise.all(providers.map((provider) => PROVIDER_PLUGINS[provider]()));
	}

	private basePlugins(llmPlugins: Plugin[]): Plugin[] {
		return [
			sqlPlugin,
			...llmPlugins,
			embeddingOpenAIPlugin,
			embeddingStubPlugin,
			vaultToolsPlugin,
			pensieveToolsPlugin,
			codingToolsPlugin,
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
			phantomWalletToolsPlugin,
			audioGenerationPlugin,
			mediaGenerationPlugin,
			desktopControlPlugin,
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
		console.log(`[runtime] provider order=[${order.join(",")}] direct-keys: openai=${!!directKeys.openai} anthropic=${!!directKeys.anthropic} openrouter=${!!directKeys.openrouter} elizacloud=${!!directKeys.elizacloud}`);
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
				console.log(
					`[runtime] active provider chain produced no usable attempts; falling back to ${p} (has direct API key in vault)`,
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
			console.log(
				`[runtime] no active provider set in vault; auto-selected ${activeProvider} from discovered OAuth/API credentials for this build`,
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
					console.log(`[runtime] using system Codex CLI auth (account_id=${systemCodex.accountId})`);
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
							console.log(`[runtime] using openai-codex account "${account.label}" (id=${account.id})`);
						},
					});
				} else {
					console.warn(`[runtime] codex token has no chatgpt_account_id claim (id=${account.id})`);
				}
			}
		} catch (err) {
			console.warn("[runtime] codex OAuth probe failed:", err instanceof Error ? err.message : err);
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
						console.log(`[runtime] using openai-api account "${account.label}" (id=${account.id})`);
					},
				});
			}
		} catch (err) {
			console.warn("[runtime] openai-api probe failed:", err instanceof Error ? err.message : err);
		}
		// Legacy single-slot OPENAI_API_KEY from the vault — kept as the
		// last OpenAI attempt for back-compat with users who set the key
		// before multi-key landed. Skips when the same key already appears
		// in the multi-key table so we don't double-attempt the same value.
		if (apiKey) {
			const dedup = attempts.some((a) => a.id.startsWith("openai:api:"));
			if (!dedup) attempts.push(this.apiAttempt("openai", "openai", "OPENAI_API_KEY", apiKey, "OpenAI API key (primary)"));
		}
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
					console.log(
						`[runtime] anthropic-subscription account "${a.label}" (id=${a.id}) access token expired at ${new Date(exp).toISOString()} ${refresh}`,
					);
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
							try {
								const fresh = await refreshAnthropicToken(c.refresh);
								access = fresh.access;
								const updated: AccountCredentialRecord = {
									...account,
									credentials: { ...c, ...fresh },
									updatedAt: Date.now(),
								};
								saveAccount(updated);
								console.log(
									`[runtime] refreshed anthropic-subscription access token for "${account.label}" (id=${account.id})`,
								);
							} catch (err) {
								console.warn(
									`[runtime] anthropic OAuth refresh failed for "${account.label}": ${err instanceof Error ? err.message : String(err)} — re-pair in Settings → Providers`,
								);
								throw err;
							}
						}
						process.env.ANTHROPIC_API_KEY = access;
						console.log(`[runtime] using anthropic-subscription account "${account.label}" (id=${account.id})`);
					},
				});
			}
		} catch (err) {
			console.warn("[runtime] anthropic OAuth probe failed:", err instanceof Error ? err.message : err);
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
						process.env.ANTHROPIC_API_KEY = key;
						console.log(`[runtime] using anthropic-api account "${account.label}" (id=${account.id})`);
					},
				});
			}
		} catch (err) {
			console.warn("[runtime] anthropic-api probe failed:", err instanceof Error ? err.message : err);
		}
		if (apiKey) {
			const dedup = attempts.some((a) => a.id.startsWith("anthropic:api:"));
			if (!dedup) attempts.push(this.apiAttempt("anthropic", "anthropic", "ANTHROPIC_API_KEY", apiKey, "Anthropic API key (primary)"));
		}
		return attempts;
	}
}
