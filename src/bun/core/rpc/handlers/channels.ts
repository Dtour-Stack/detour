import type { IAgentRuntime } from "@elizaos/core";
import { runDiscordCatchUp } from "../../discord-catchup";
import type { RpcDeps } from "../types";

/**
 * Channels handler factory — covers `/api/channels/*` HTTP routes:
 *
 *   - channelsList                    (GET /api/channels)
 *   - channelsSetCredential           (POST /api/channels/credentials)
 *   - channelsClearCredential         (DELETE /api/channels/credentials/:key)
 *   - channelsReload                  (POST /api/channels/reload)
 *   - channelsDiscordGuilds           (GET /api/channels/discord/guilds)
 *   - channelsDiscordBackfill         (POST /api/channels/discord/backfill)
 *   - channelsDiscordCatchUp          (POST /api/channels/discord/catch-up)
 *
 * Wire shapes are identical to the HTTP routes in src/bun/core/api/server.ts.
 * The credential validation + reload-debounce logic is duplicated from the
 * HTTP layer for now; both layers run in parallel until the HTTP routes are
 * deleted in a later phase.
 */

// ---- Credential validation (mirror of server.ts) -----------------------

type CredentialValidationResult = { ok: true; info?: string } | { ok: false; error: string };
type CredentialValidator = (key: string, trimmed: string) => Promise<CredentialValidationResult>;

const CREDENTIAL_VALIDATION_TIMEOUT_MS = 5000;

async function fetchCredentialValidation(url: string, init: RequestInit = {}): Promise<Response> {
	const ctl = new AbortController();
	const t = setTimeout(() => ctl.abort(), CREDENTIAL_VALIDATION_TIMEOUT_MS);
	try {
		return await fetch(url, { ...init, signal: ctl.signal });
	} finally {
		clearTimeout(t);
	}
}

async function validateDiscordCredential(trimmed: string): Promise<CredentialValidationResult> {
	try {
		const res = await fetchCredentialValidation("https://discord.com/api/v10/users/@me", {
			headers: { Authorization: `Bot ${trimmed}` },
		});
		if (res.status === 401) return { ok: false, error: "Discord rejected the token (401 Unauthorized) — regenerate it in Developer Portal → Bot → Reset Token." };
		if (res.status === 403) return { ok: false, error: "Discord rejected the token (403 Forbidden) — bot lacks required permissions." };
		if (!res.ok) return { ok: false, error: `Discord token check failed: HTTP ${res.status}` };
		const body = await res.json() as { username?: string; id?: string };
		if (!body.id || !body.username) return { ok: false, error: "Discord responded but token didn't return a bot user" };
		return { ok: true };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `Could not reach Discord to validate token: ${msg}` };
	}
}

async function validateTelegramCredential(trimmed: string): Promise<CredentialValidationResult> {
	try {
		const res = await fetchCredentialValidation(`https://api.telegram.org/bot${encodeURIComponent(trimmed)}/getMe`);
		const body = await res.json() as { ok?: boolean; description?: string; result?: { username?: string } };
		if (!body.ok) return { ok: false, error: `Telegram rejected the token: ${body.description ?? "unknown error"}` };
		if (!body.result?.username) return { ok: false, error: "Telegram responded but didn't return bot info" };
		return { ok: true };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `Could not reach Telegram to validate token: ${msg}` };
	}
}

async function validateGitHubCredential(trimmed: string): Promise<CredentialValidationResult> {
	try {
		const res = await fetchCredentialValidation("https://api.github.com/user", {
			headers: {
				Authorization: `Bearer ${trimmed}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		});
		if (res.status === 401) return { ok: false, error: "GitHub rejected the token (401 Unauthorized)." };
		if (res.status === 403) return { ok: false, error: "GitHub rejected the token (403 Forbidden or rate limited)." };
		if (!res.ok) return { ok: false, error: `GitHub token check failed: HTTP ${res.status}` };
		const body = await res.json() as { login?: string };
		return { ok: true, ...(body.login ? { info: `signed in as @${body.login}` } : {}) };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `Could not reach GitHub to validate token: ${msg}` };
	}
}

async function validateOpenAICredential(trimmed: string): Promise<CredentialValidationResult> {
	try {
		const res = await fetchCredentialValidation("https://api.openai.com/v1/models", {
			headers: { Authorization: `Bearer ${trimmed}` },
		});
		if (res.status === 401) return { ok: false, error: "OpenAI rejected the API key (401 Unauthorized)." };
		if (!res.ok) return { ok: false, error: `OpenAI key check failed: HTTP ${res.status}` };
		return { ok: true };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `Could not reach OpenAI to validate key: ${msg}` };
	}
}

async function validateXCredential(key: string, trimmed: string): Promise<CredentialValidationResult> {
	const otherKey = key === "X_AUTH_TOKEN" ? "X_CT0" : "X_AUTH_TOKEN";
	const otherValue = process.env[otherKey];
	if (!otherValue) return { ok: true };
	void trimmed;
	return { ok: true };
}

const CREDENTIAL_VALIDATORS: Record<string, CredentialValidator> = {
	DISCORD_API_TOKEN: (_key, trimmed) => validateDiscordCredential(trimmed),
	DISCORD_BOT_TOKEN: (_key, trimmed) => validateDiscordCredential(trimmed),
	TELEGRAM_BOT_TOKEN: (_key, trimmed) => validateTelegramCredential(trimmed),
	GITHUB_TOKEN: (_key, trimmed) => validateGitHubCredential(trimmed),
	GITHUB_USER_PAT: (_key, trimmed) => validateGitHubCredential(trimmed),
	GITHUB_AGENT_PAT: (_key, trimmed) => validateGitHubCredential(trimmed),
	OPENAI_EMBEDDING_API_KEY: (_key, trimmed) => validateOpenAICredential(trimmed),
	OPENAI_API_KEY: (_key, trimmed) => validateOpenAICredential(trimmed),
	X_AUTH_TOKEN: validateXCredential,
	X_CT0: validateXCredential,
};

async function validateChannelCredential(key: string, value: string): Promise<CredentialValidationResult> {
	const trimmed = value.trim();
	if (trimmed.length === 0) return { ok: false, error: `${key} is empty` };
	const validate = CREDENTIAL_VALIDATORS[key];
	return validate ? validate(key, trimmed) : { ok: true };
}

// ---- Reload debouncer (mirror of ApiServer.scheduleChannelReload) ------

/**
 * Same 1.5s debounce as the HTTP server. Shared module-local timer so
 * back-to-back calls (e.g. user pasting Discord + Telegram tokens) coalesce
 * into a single rebuild — Telegraf's 5-attempt retry-with-backoff makes
 * overlapping rebuilds fight each other.
 */
let channelReloadTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleChannelReload(deps: RpcDeps): void {
	if (channelReloadTimer) clearTimeout(channelReloadTimer);
	channelReloadTimer = setTimeout(() => {
		channelReloadTimer = null;
		void deps.runtime.rebuild().catch((err) => {
			console.warn("[channels] debounced auto-reload failed:", err);
		});
	}, 1500);
}

// ---- Helpers for the loose discord client cast (matches server.ts) ----

type DiscordServiceShape = {
	client?: {
		guilds?: {
			cache?: Map<
				string,
				{
					id: string;
					name: string;
					channels?: { cache?: Map<string, { id: string; name: string; type?: number }> };
				}
			>;
		};
	};
	fetchChannelHistory?: (
		channelId: string,
		opts: { limit?: number; force?: boolean },
	) => Promise<{ stats: { fetched: number; stored: number; pages: number; fullyBackfilled: boolean } }>;
};

function getDiscordService(runtime: IAgentRuntime | null): DiscordServiceShape | null {
	if (!runtime) return null;
	return ((runtime as unknown as { getService?: (t: string) => unknown }).getService?.("discord") as DiscordServiceShape | undefined) ?? null;
}

// ---- Handlers ----------------------------------------------------------

export function channelsRequests(deps: RpcDeps) {
	return {
		channelsList: async (_params: Record<string, never>) => {
			const snap = deps.activity.pluginsSnapshot();
			const loadedNames = snap.plugins.map((p) => p.name);
			const liveRuntime = deps.runtime.peek();
			return deps.channels.snapshot(loadedNames, liveRuntime);
		},

		channelsSetCredential: async (params: { key: string; value: string; skipValidate?: boolean }) => {
			if (!params.skipValidate) {
				const validation = await validateChannelCredential(params.key, params.value);
				if (!validation.ok) {
					throw new Error(validation.error);
				}
			}
			await deps.channels.setCredential(params.key, params.value);
			scheduleChannelReload(deps);
			return { ok: true as const, reloadScheduled: true as const, validated: !params.skipValidate };
		},

		channelsClearCredential: async (params: { key: string }) => {
			await deps.channels.clearCredential(params.key);
			scheduleChannelReload(deps);
			return { ok: true as const, reloadScheduled: true as const };
		},

		channelsReload: async (_params: Record<string, never>) => {
			scheduleChannelReload(deps);
			return { ok: true as const, reloadScheduled: true as const };
		},

		channelsDiscordGuilds: async (_params: Record<string, never>) => {
			const live = deps.runtime.peek();
			const svc = getDiscordService(live);
			const cache = svc?.client?.guilds?.cache;
			if (!cache) return { guilds: [] };
			const out: Array<{ id: string; name: string; channels: Array<{ id: string; name: string; type: number }> }> = [];
			for (const [, g] of cache) {
				const channels: Array<{ id: string; name: string; type: number }> = [];
				const ch = g.channels?.cache;
				if (ch) for (const [, c] of ch) {
					channels.push({ id: c.id, name: c.name, type: c.type ?? -1 });
				}
				out.push({ id: g.id, name: g.name, channels });
			}
			return { guilds: out };
		},

		channelsDiscordBackfill: async (params: { channelId: string; limit?: number; force?: boolean }) => {
			const live = deps.runtime.peek();
			const svc = getDiscordService(live);
			if (!svc?.fetchChannelHistory) throw new Error("Discord service not loaded");
			// Run in background; client polls trajectories/memories to see progress.
			void svc
				.fetchChannelHistory(params.channelId, { limit: params.limit ?? 200, force: !!params.force })
				.then((r) => console.log(`[discord] backfill complete for ${params.channelId}:`, r.stats))
				.catch((err) => console.warn(`[discord] backfill failed for ${params.channelId}:`, err instanceof Error ? err.message : err));
			return { ok: true as const, scheduled: true as const, channelId: params.channelId };
		},

		channelsDiscordCatchUp: async (params: { channelId?: string; limit?: number; maxAgeHours?: number; wait?: boolean }) => {
			const live = deps.runtime.peek();
			if (!live) throw new Error("runtime not built");
			const channelId = params.channelId;
			const limit = params.limit ?? 100;
			const maxAgeHours = params.maxAgeHours ?? 24;
			const options = {
				...(channelId ? { channelId } : {}),
				limit,
				maxAgeMs: maxAgeHours > 0 ? maxAgeHours * 60 * 60_000 : 0,
			};
			const wait = params.wait ?? Boolean(channelId);
			if (wait) {
				const result = await runDiscordCatchUp(live, options);
				return {
					ok: true as const,
					scheduled: false,
					...(channelId ? { channelId } : {}),
					result,
				};
			}
			void runDiscordCatchUp(live, options).catch((err) => {
				const runtime = deps.runtime.peek();
				runtime?.logger.warn(
					{
						src: "rpc:discord-catchup",
						channelId,
						error: err instanceof Error ? err.message : String(err),
					},
					"Discord catch-up failed",
				);
			});
			return {
				ok: true as const,
				scheduled: true,
				...(channelId ? { channelId } : {}),
			};
		},
	};
}
