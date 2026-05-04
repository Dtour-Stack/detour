import {
	AgentRuntime,
	ChannelType,
	type Character,
	createCharacter,
	createMessageMemory,
	type Plugin,
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
import { decodeCodexJwt } from "@detour/plugin-codex-chatgpt";
import { vaultToolsPlugin } from "@detour/plugin-vault-tools";

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

export class RuntimeService {
	private current: RuntimeState | null = null;
	private buildPromise: Promise<RuntimeState | null> | null = null;

	constructor(
		private readonly vault: VaultService,
		// auth dep is currently sourced via the singleton listAccounts() helper;
		// keeping the constructor slot lets callers pass it for future scoping.
		_auth?: AuthService,
	) {
		void _auth;
	}

	async getOrBuild(): Promise<RuntimeState | null> {
		if (this.current) return this.current;
		if (!this.buildPromise) {
			this.buildPromise = this.build()
				.then((state) => {
					this.current = state;
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

		const runtime = new AgentRuntime({
			character,
			plugins: [sqlPlugin, llmPlugin, embeddingStubPlugin, vaultToolsPlugin],
		});
		await runtime.initialize();

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
	 *   anthropic-subscription → set ANTHROPIC_API_KEY = sk-ant-oat… token,
	 *     plugin-anthropic + the stealth interceptor handle the rest.
	 *   openai-codex          → no compatible plugin path today (token is a
	 *     ChatGPT JWT, not an OpenAI API key). Skip.
	 *
	 * Returns null when nothing usable is available so we fall through to
	 * the vault keys path.
	 */
	private async pickFromOAuth(): Promise<ProviderId | "codex-chatgpt" | null> {
		// Anthropic first — claude-code-stealth interceptor handles plugin-anthropic.
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

		// Codex/ChatGPT subscription via @detour/plugin-codex-chatgpt — talks
		// to chatgpt.com/backend-api/codex/responses with the OAuth Bearer.
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
				if (!acctId) {
					console.warn("[runtime] codex token has no chatgpt_account_id claim — skipping");
				} else {
					process.env.CODEX_OAUTH_TOKEN = token;
					process.env.CODEX_CHATGPT_ACCOUNT_ID = acctId;
					console.log(
						`[runtime] using openai-codex account "${pick.label}" (id=${pick.id}, chatgpt_account_id=${acctId})`,
					);
					return "codex-chatgpt";
				}
			}
		} catch (err) {
			console.warn("[runtime] codex OAuth probe failed:", err instanceof Error ? err.message : err);
		}
		return null;
	}
}
