import {
	AgentRuntime,
	ChannelType,
	type Character,
	createCharacter,
	createMessageMemory,
	type Plugin,
	provisionAgent,
	stringToUuid,
	type UUID,
} from "@elizaos/core";
import sqlPlugin from "@elizaos/plugin-sql";
import { v4 as uuidv4 } from "uuid";
import type { ProviderId } from "@detour/shared";
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
import { pensieveToolsPlugin } from "@detour/plugin-pensieve-tools";
import { vaultToolsPlugin } from "@detour/plugin-vault-tools";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
const USER_ID = uuidv4() as UUID;

type RuntimeState = {
	runtime: AgentRuntime;
	provider: ProviderId | "codex-chatgpt";
};

const PROVIDER_PLUGINS: Record<ProviderId | "codex-chatgpt", () => Promise<Plugin>> = {
	anthropic: async () => (await import("@elizaos/plugin-anthropic")).default,
	openai: async () => (await import("@elizaos/plugin-openai")).default,
	"codex-chatgpt": async () => (await import("@detour/plugin-codex-chatgpt")).default,
};

type AfterBuildHook = (state: RuntimeState) => Promise<void> | void;

export class RuntimeService {
	private current: RuntimeState | null = null;
	private buildPromise: Promise<RuntimeState | null> | null = null;
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

	constructor(
		private readonly vault: VaultService,
		// auth dep is currently sourced via the singleton listAccounts() helper;
		// keeping the constructor slot lets callers pass it for future scoping.
		_auth?: AuthService,
		private readonly channels?: import("./channels").ChannelsService,
		private gateway?: import("./channels/gateway").ChannelGatewayService,
	) {
		void _auth;
	}

	setGateway(gateway: import("./channels/gateway").ChannelGatewayService): void {
		this.gateway = gateway;
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
		const message = createMessageMemory({
			id: uuidv4() as UUID,
			entityId: USER_ID,
			roomId: ROOM_ID,
			content: { text, source: "tray-app", channelType: ChannelType.DM },
		});
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
		// Prefer OAuth subscription tokens when present + not expired —
		// claude-code-stealth-fetch-interceptor swaps Anthropic-subscription
		// tokens in for x-api-key, and the new codex-chatgpt plugin handles
		// OpenAI Codex JWTs natively against chatgpt.com/backend-api.
		let provider: ProviderId | "codex-chatgpt" | null = await this.pickFromOAuth();
		if (!provider) {
			const direct = await this.vault.loadKeysIntoEnv();
			if (direct) provider = direct;
		}
		if (!provider) return null;

		const llmPlugin = await PROVIDER_PLUGINS[provider]();
		const character: Character = createCharacter({
			name: "Detour",
			bio: "A helpful assistant living in your menu bar.",
		});

		// Channel plugins load conditionally based on vault credentials —
		// no Discord bot in memory unless DISCORD_API_TOKEN is set, etc.
		// Channel credentials also need to flow into AgentRuntime.settings
		// so plugins' `runtime.getSetting("DISCORD_API_TOKEN")` finds them.
		// (eliza's getSetting checks character.secrets/settings + opts.settings,
		// NOT process.env.)
		const channelResolved = this.channels
			? await this.channels.resolvePlugins()
			: { plugins: [], settings: {} as Record<string, string> };
		if (channelResolved.plugins.length > 0) {
			console.log(`[runtime] loading ${channelResolved.plugins.length} channel plugin(s): ${channelResolved.plugins.map((p) => p.name).join(", ")}`);
		}

		// Build the consolidated settings map that AgentRuntime sees via
		// `runtime.getSetting()`. This is the only place eliza's `provisionAgent`
		// looks for EMBEDDING_DIMENSION (which routes vectors to the right
		// dim_N column in the embeddings table). Our local llama-server ships
		// bge-small-en-v1.5 (384-dim) so we pin the dimension here. The
		// OPENAI_EMBEDDING_URL/KEY are also threaded so the embedding plugin
		// finds the local server even when process.env hasn't propagated yet.
		const settings: Record<string, string> = {
			...channelResolved.settings,
			EMBEDDING_DIMENSION: "384",
		};
		const llamaUrl = process.env.OPENAI_EMBEDDING_URL;
		if (typeof llamaUrl === "string" && llamaUrl.length > 0 && !settings.OPENAI_EMBEDDING_URL) {
			settings.OPENAI_EMBEDDING_URL = llamaUrl;
		}
		if (process.env.OPENAI_EMBEDDING_API_KEY && !settings.OPENAI_EMBEDDING_API_KEY) {
			settings.OPENAI_EMBEDDING_API_KEY = process.env.OPENAI_EMBEDDING_API_KEY;
		}
		settings.OPENAI_EMBEDDING_DIMENSIONS = "384";

		const runtime = new AgentRuntime({
			character,
			// embeddingOpenAIPlugin first so it wins TEXT_EMBEDDING registration
			// (eliza picks first-registered for equal priority). It internally
			// falls back to zero vectors when OPENAI_EMBEDDING_API_KEY is unset,
			// so embeddingStubPlugin is now redundant — kept as final safety net.
			plugins: [sqlPlugin, llmPlugin, embeddingOpenAIPlugin, embeddingStubPlugin, vaultToolsPlugin, pensieveToolsPlugin, ...channelResolved.plugins],
			settings,
		});
		await runtime.initialize();
		// provisionAgent runs migrations + ensures the database adapter knows
		// which dim_N column to use for embeddings (reads EMBEDDING_DIMENSION
		// from settings — we set it to 384 above for bge-small-en-v1.5).
		// Without this call the adapter falls back to its default dim and
		// our 384-dim vectors get truncated/padded into the wrong column.
		// runMigrations:false because plugin-sql already migrated during init.
		try {
			await provisionAgent(runtime, { runMigrations: false });
		} catch (err) {
			console.warn("[runtime] provisionAgent failed:", err instanceof Error ? err.message : err);
		}
		// Eliza's TaskService timer is opt-in — comment in services/task.ts:
		//   "Start the task poll timer. Call explicitly in daemon mode; not
		//    started automatically. Daemon entry points that need scheduled
		//    tasks call getService('task') then startTimer()."
		// We're a long-lived tray daemon, so we start it. Without this,
		// repeat tasks (EMBEDDING_DRAIN, IMESSAGE_HEARTBEAT, follow-ups) never
		// fire — the embedding queue accumulates items forever.
		//
		// Second gotcha: TaskService.checkTasks() guards on `tasksDirty` and
		// only flips it true on `markDirty()` — which eliza doesn't call from
		// createTask/updateTask in non-companion mode. So after the first
		// tick the queue stays "clean" and EMBEDDING_DRAIN never re-fires.
		// We force a periodic markDirty so repeat tasks always get a chance.
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
	 *   1. system Codex CLI auth (`~/.codex/auth.json`) — set by `codex login`
	 *   2. our own per-account OAuth files (`~/.eliza/auth/openai-codex/*.json`)
	 *   3. anthropic-subscription as fallback
	 *
	 * Reading the system Codex CLI's auth means the user only logs in ONCE
	 * via the CLI (or ChatGPT desktop app, which writes the same file) and
	 * the desktop app picks it up automatically — no re-auth dance.
	 */
	private async pickFromOAuth(): Promise<ProviderId | "codex-chatgpt" | null> {
		// 1. Try the system Codex CLI auth file first — user's existing login.
		const systemCodex = await detectSystemCodexAuth();
		if (systemCodex) {
			process.env.CODEX_OAUTH_TOKEN = systemCodex.accessToken;
			process.env.CODEX_CHATGPT_ACCOUNT_ID = systemCodex.accountId;
			console.log(
				`[runtime] using system Codex CLI auth from ~/.codex/auth.json (account_id=${systemCodex.accountId}) — primary provider, no re-auth required`,
			);
			return "codex-chatgpt";
		}

		// 2. Fall back to our own per-account OAuth files.
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
						`[runtime] using openai-codex account "${pick.label}" (id=${pick.id}, chatgpt_account_id=${acctId}) — primary provider`,
					);
					return "codex-chatgpt";
				}
				console.warn("[runtime] codex token has no chatgpt_account_id claim — falling back to anthropic");
			}
		} catch (err) {
			console.warn("[runtime] codex OAuth probe failed:", err instanceof Error ? err.message : err);
		}

		// Anthropic fallback.
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
				console.log(`[runtime] using anthropic-subscription account "${pick.label}" (id=${pick.id}) — fallback provider`);
				return "anthropic";
			}
		} catch (err) {
			console.warn("[runtime] anthropic OAuth probe failed:", err instanceof Error ? err.message : err);
		}

		return null;
	}
}
