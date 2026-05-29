/**
 * local-chat plugin — registers TEXT_SMALL / TEXT_MEDIUM / TEXT_LARGE
 * handlers backed by a local llama-server running a chat model.
 *
 * Routing posture:
 *   - Default priority: 5 (below codex-chatgpt at 100, anthropic at 90).
 *     The plugin is a recovery fallback — when Codex hits a quota cap or
 *     the user is offline, this kicks in.
 *   - When DETOUR_LOCAL_CHAT_PRIMARY=true is set, priority becomes 200
 *     so it outranks every cloud provider and runs first. This is the
 *     "use local as my primary" toggle in Settings → Local AI.
 *
 * URL discovery:
 *   - Reads DETOUR_LOCAL_CHAT_URL at handler-invocation time (not at
 *     register time) so a runtime rebuild after the user enables local
 *     chat picks up the URL automatically.
 *   - Returns a NoModelProviderConfiguredError-equivalent (throws) when
 *     the env var is unset — the dpe-fallback chain then continues to
 *     the next provider in line.
 *
 * Streaming:
 *   - The OpenAI-compatible /v1/chat/completions endpoint supports
 *     stream=true; we forward delta tokens to params.onStreamChunk when
 *     present (planner / streaming-reply paths). For non-streaming
 *     callers we collect the response and return it whole.
 */

import {
	ModelType,
	logger,
	type IAgentRuntime,
	type Plugin,
	type GenerateTextParams,
} from "@elizaos/core";

const STREAM_TIMEOUT_MS = 120_000;

function pickSetting(runtime: IAgentRuntime, key: string): string | undefined {
	const v = runtime.getSetting?.(key);
	if (typeof v === "string" && v.trim().length > 0) return v.trim();
	const env = process.env[key];
	return typeof env === "string" && env.trim().length > 0 ? env.trim() : undefined;
}

function asBoolean(value: string | undefined): boolean {
	if (!value) return false;
	const n = value.toLowerCase();
	return ["1", "true", "yes", "on"].includes(n);
}

// ── Health probe ──────────────────────────────────────────────────
const HEALTH_CACHE_MS = 5_000;
const HEALTH_PROBE_TIMEOUT_MS = 1_500;

/** Cached health state so we don't probe on every model call. */
let lastHealthProbe: { ok: boolean; at: number } | null = null;

/**
 * Lightweight /health probe with a short-lived cache. Returns true when
 * the llama-server is responding, false when it's down or unreachable.
 * The 5s cache means at most one real probe per DPE planning cycle even
 * when the chain walks TEXT_SMALL → MEDIUM → LARGE in quick succession.
 */
async function probeLocalChatHealth(url: string): Promise<boolean> {
	const now = Date.now();
	if (lastHealthProbe && now - lastHealthProbe.at < HEALTH_CACHE_MS) {
		return lastHealthProbe.ok;
	}
	try {
		const ctl = new AbortController();
		const timer = setTimeout(() => ctl.abort(), HEALTH_PROBE_TIMEOUT_MS);
		const res = await fetch(`${url}/health`, { signal: ctl.signal });
		clearTimeout(timer);
		const ok = res.ok;
		lastHealthProbe = { ok, at: now };
		return ok;
	} catch {
		lastHealthProbe = { ok: false, at: now };
		return false;
	}
}

/** Invalidate the cached health state — called externally when the
 *  llama-server is known to have (re)started. */
export function resetLocalChatHealthCache(): void {
	lastHealthProbe = null;
}

/**
 * Resolve the local-chat URL at call time. When DETOUR_LOCAL_CHAT_URL is
 * unset the service hasn't been enabled — throw so the planner's
 * recovery chain falls through to the next provider.
 */
function resolveLocalChatUrl(runtime: IAgentRuntime): string {
	const url = pickSetting(runtime, "DETOUR_LOCAL_CHAT_URL");
	if (!url) {
		throw new Error(
			"local-chat: DETOUR_LOCAL_CHAT_URL not set — local chat service not running",
		);
	}
	return url.replace(/\/$/, "");
}

function extractPromptText(params: GenerateTextParams | string | unknown): string {
	if (typeof params === "string") return params;
	if (params && typeof params === "object") {
		const p = params as { prompt?: unknown };
		if (typeof p.prompt === "string") return p.prompt;
	}
	return "";
}

function extractStreamCallback(
	params: GenerateTextParams | unknown,
):
	| ((chunk: string, messageId?: string, accumulated?: string) => void)
	| undefined {
	if (!params || typeof params !== "object") return undefined;
	const p = params as { onStreamChunk?: unknown };
	if (typeof p.onStreamChunk === "function") {
		return p.onStreamChunk as (
			chunk: string,
			messageId?: string,
			accumulated?: string,
		) => void;
	}
	return undefined;
}

/**
 * Forward `maxTokens` / `temperature` / `stopSequences` from
 * `GenerateTextParams`; caller wins, otherwise per-tier defaults apply.
 * `stopSequences` accepts string-or-array (upstream callers vary) and
 * normalizes to string[].
 */
function extractSamplingControls(
	params: GenerateTextParams | unknown,
	defaults: { maxTokens: number; temperature: number },
): { maxTokens: number; temperature: number; stopSequences: string[] } {
	const out = {
		maxTokens: defaults.maxTokens,
		temperature: defaults.temperature,
		stopSequences: [] as string[],
	};
	if (!params || typeof params !== "object") return out;
	const p = params as {
		maxTokens?: unknown;
		temperature?: unknown;
		stopSequences?: unknown;
	};
	if (typeof p.maxTokens === "number" && p.maxTokens > 0) {
		out.maxTokens = Math.floor(p.maxTokens);
	}
	if (typeof p.temperature === "number" && Number.isFinite(p.temperature)) {
		out.temperature = p.temperature;
	}
	if (Array.isArray(p.stopSequences)) {
		out.stopSequences = p.stopSequences.filter(
			(s): s is string => typeof s === "string" && s.length > 0,
		);
	} else if (typeof p.stopSequences === "string" && p.stopSequences.length > 0) {
		out.stopSequences = [p.stopSequences];
	}
	return out;
}

/**
 * Wrap the user's prompt in a Q:/A: scaffold so a base (un-fine-tuned)
 * model has structure to continue. Base models don't know they're
 * supposed to play "assistant" — they just predict the next token. The
 * Q:/A: pattern is the simplest priming that gets them into a question-
 * answer shape without depending on instruction tuning.
 *
 * We stop generation when the model starts emitting a new "Q:" (it's
 * about to loop), or when an explicit double newline + Q appears.
 */
function wrapAsCompletion(prompt: string): { input: string; stopTokens: string[] } {
	const input = `The following is a conversation between a user and an AI assistant.\n\nQ: ${prompt}\nA:`;
	return { input, stopTokens: ["\nQ:", "\n\nQ:", "Q:"] };
}

/**
 * Read the current local-chat mode. Set by LocalChatService when it
 * spawns the llama-server: "chat" for instruct-tuned presets,
 * "completion" for raw/base models like eliza-1.
 */
function resolveMode(): "chat" | "completion" {
	const v = process.env.DETOUR_LOCAL_CHAT_MODE;
	return v === "completion" ? "completion" : "chat";
}

/**
 * Chat-completions path. Used when the active preset is instruct-tuned.
 * Streams when onStreamChunk is provided so eliza's planner reacts to
 * deltas in real time; collects + returns the full text either way.
 */
async function callChatCompletions(
	url: string,
	prompt: string,
	options: {
		maxTokens?: number;
		temperature?: number;
		stopSequences?: string[];
		onStreamChunk?: (chunk: string, messageId?: string, accumulated?: string) => void;
	},
): Promise<string> {
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), STREAM_TIMEOUT_MS);
	try {
		const stream = typeof options.onStreamChunk === "function";
		const body: Record<string, unknown> = {
			messages: [{ role: "user", content: prompt }],
			stream,
		};
		if (typeof options.maxTokens === "number" && options.maxTokens > 0) {
			body.max_tokens = Math.floor(options.maxTokens);
		}
		if (typeof options.temperature === "number") {
			body.temperature = options.temperature;
		}
		if (options.stopSequences && options.stopSequences.length > 0) {
			body.stop = options.stopSequences;
		}
		const res = await fetch(`${url}/v1/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: ctl.signal,
		});
		if (!res.ok) {
			throw new Error(`local-chat HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
		}
		if (!stream) {
			const data = (await res.json()) as {
				choices?: Array<{ message?: { content?: string } }>;
			};
			return data.choices?.[0]?.message?.content ?? "";
		}
		const reader = res.body?.getReader();
		if (!reader) throw new Error("local-chat stream missing body reader");
		const decoder = new TextDecoder();
		let buffer = "";
		let collected = "";
		const cb = options.onStreamChunk!;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let idx = buffer.indexOf("\n");
			while (idx >= 0) {
				const line = buffer.slice(0, idx).trim();
				buffer = buffer.slice(idx + 1);
				if (line.startsWith("data:")) {
					const payload = line.slice("data:".length).trim();
					if (payload === "[DONE]") break;
					try {
						const json = JSON.parse(payload) as {
							choices?: Array<{ delta?: { content?: string } }>;
						};
						const delta = json.choices?.[0]?.delta?.content ?? "";
						if (delta) {
							collected += delta;
							cb(delta, undefined, collected);
						}
					} catch {
						// llama-server sometimes emits partial JSON; ignore.
					}
				}
				idx = buffer.indexOf("\n");
			}
		}
		return collected;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Text-completion path for BASE models (eliza-1 v1, etc.). The model
 * isn't trained to roleplay assistant — feed it Q:/A: text and let it
 * continue. Stops on the next "Q:" so the model doesn't roleplay the
 * user back to itself in a loop.
 */
async function callTextCompletion(
	url: string,
	prompt: string,
	options: {
		maxTokens?: number;
		temperature?: number;
		stopSequences?: string[];
		onStreamChunk?: (chunk: string, messageId?: string, accumulated?: string) => void;
	},
): Promise<string> {
	const { input, stopTokens } = wrapAsCompletion(prompt);
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), STREAM_TIMEOUT_MS);
	try {
		const stream = typeof options.onStreamChunk === "function";
		// Merge the scaffold-required stop tokens (so a base model can't
		// roleplay back as the user) with caller-supplied stops. Dedup so
		// the body stays compact.
		const stop = Array.from(
			new Set([...stopTokens, ...(options.stopSequences ?? [])]),
		);
		const body: Record<string, unknown> = {
			prompt: input,
			stream,
			stop,
		};
		if (typeof options.maxTokens === "number" && options.maxTokens > 0) {
			body.max_tokens = Math.floor(options.maxTokens);
		}
		if (typeof options.temperature === "number") {
			body.temperature = options.temperature;
		}
		const res = await fetch(`${url}/v1/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: ctl.signal,
		});
		if (!res.ok) {
			throw new Error(`local-chat HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
		}
		if (!stream) {
			const data = (await res.json()) as {
				choices?: Array<{ text?: string }>;
			};
			return (data.choices?.[0]?.text ?? "").trim();
		}
		const reader = res.body?.getReader();
		if (!reader) throw new Error("local-chat stream missing body reader");
		const decoder = new TextDecoder();
		let buffer = "";
		let collected = "";
		const cb = options.onStreamChunk!;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let idx = buffer.indexOf("\n");
			while (idx >= 0) {
				const line = buffer.slice(0, idx).trim();
				buffer = buffer.slice(idx + 1);
				if (line.startsWith("data:")) {
					const payload = line.slice("data:".length).trim();
					if (payload === "[DONE]") break;
					try {
						// /v1/completions streams differ from /v1/chat/completions:
						// delta lives at choices[0].text not choices[0].delta.content.
						const json = JSON.parse(payload) as {
							choices?: Array<{ text?: string }>;
						};
						const delta = json.choices?.[0]?.text ?? "";
						if (delta) {
							collected += delta;
							cb(delta, undefined, collected);
						}
					} catch {
						// llama-server sometimes emits partial JSON; ignore.
					}
				}
				idx = buffer.indexOf("\n");
			}
		}
		return collected.trim();
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Dispatch to chat or completion endpoint based on the active preset's
 * mode. Instruct-tuned models get /v1/chat/completions; base models
 * (eliza-1 v1) get /v1/completions with a Q:/A: scaffold.
 */
async function callLocalChat(
	url: string,
	prompt: string,
	options: {
		maxTokens?: number;
		temperature?: number;
		stopSequences?: string[];
		onStreamChunk?: (chunk: string, messageId?: string, accumulated?: string) => void;
	},
): Promise<string> {
	const mode = resolveMode();
	if (mode === "completion") {
		return callTextCompletion(url, prompt, options);
	}
	return callChatCompletions(url, prompt, options);
}

/**
 * Resolve plugin priority at runtime. Default = low (5) so cloud
 * providers win. When DETOUR_LOCAL_CHAT_PRIMARY=true the priority bumps
 * to 200 so local outranks everything (including codex-chatgpt at 100).
 *
 * Gated on DETOUR_LOCAL_CHAT_URL actually being set — i.e. local-chat
 * is *running*. If the user has PRIMARY=true sticky in .env but hasn't
 * started the local-chat service this session, the plugin would
 * otherwise win every routing decision and then fail every call
 * ("DETOUR_LOCAL_CHAT_URL not set"), wedging the agent loop with no
 * fallback. Drop to default priority when the URL is missing so cloud
 * providers take over until local-chat is actually started.
 */
function resolvePriority(): number {
	const isPrimary = asBoolean(
		process.env.DETOUR_LOCAL_CHAT_PRIMARY,
	);
	if (!isPrimary) return 5;
	const url = process.env.DETOUR_LOCAL_CHAT_URL;
	if (typeof url !== "string" || url.trim().length === 0) return 5;
	return 200;
}

/**
 * Per-tier default `maxTokens`. Caller params override via
 * `extractSamplingControls`; these only apply when the caller didn't
 * specify a maxTokens of their own.
 */
const DEFAULT_MAX_TOKENS: Record<string, number> = {
	[ModelType.TEXT_SMALL]: 512,
	[ModelType.TEXT_MEDIUM]: 1024,
	[ModelType.TEXT_LARGE]: 2048,
};

function makeTextHandler(modelType: string) {
	return async (
		runtime: IAgentRuntime,
		params: GenerateTextParams | string,
	): Promise<string> => {
		const url = resolveLocalChatUrl(runtime);
		const healthy = await probeLocalChatHealth(url);
		if (!healthy) {
			throw new Error(
				`local-chat: llama-server not responding at ${url} — falling through to next provider`,
			);
		}
		const prompt = extractPromptText(params);
		if (!prompt) return "";
		const onStreamChunk = extractStreamCallback(params);
		const controls = extractSamplingControls(params, {
			maxTokens: DEFAULT_MAX_TOKENS[modelType] ?? 1024,
			temperature: 0.7,
		});
		try {
			return await callLocalChat(url, prompt, {
				...controls,
				...(onStreamChunk ? { onStreamChunk } : {}),
			});
		} catch (err) {
			logger.warn(
				{
					src: "local-chat",
					modelType,
					err: err instanceof Error ? err.message : String(err),
				},
				`local-chat ${modelType} call failed`,
			);
			throw err;
		}
	};
}

export const localChatPlugin: Plugin = {
	name: "local-chat",
	description:
		"Local chat-completions handler. Routes TEXT_SMALL/MEDIUM/LARGE to a llama-server instance running a chat model (default: Qwen3-4B-Instruct). Default priority is below cloud providers; toggle DETOUR_LOCAL_CHAT_PRIMARY=true to make it the primary text provider.",
	get priority() {
		return resolvePriority();
	},
	models: {
		[ModelType.TEXT_SMALL]: makeTextHandler(ModelType.TEXT_SMALL),
		[ModelType.TEXT_MEDIUM]: makeTextHandler(ModelType.TEXT_MEDIUM),
		[ModelType.TEXT_LARGE]: makeTextHandler(ModelType.TEXT_LARGE),
	},
};

export default localChatPlugin;
