/**
 * dev-inference plugin — routes TEXT_SMALL / TEXT_MEDIUM / TEXT_LARGE to an
 * OpenAI-compatible "free LLM" proxy for local development + testing.
 *
 * Why this exists (and why it is NOT wired through plugin-openai):
 *   - The dev proxy (Dexploarer's rotating free-tier key, default
 *     http://localhost:3001/v1) serves only chat completions. It does NOT
 *     serve `/v1/embeddings` (verified: returns 404 "Cannot POST
 *     /v1/embeddings"). If we instead made `@elizaos/plugin-openai` the
 *     active provider by setting OPENAI_BASE_URL/OPENAI_API_KEY, that plugin
 *     would win TEXT_EMBEDDING too (it registers every model type) and route
 *     embeddings at the proxy's missing endpoint — breaking the memory / RAG
 *     pipeline whenever dev mode is on.
 *   - Mirroring the `local-chat` plugin instead keeps this strictly a TEXT_*
 *     handler: embeddings stay on `embedding-openai` / the bge stub, the
 *     user's vault-pinned `activeProvider` is untouched, and the provider
 *     quota banner doesn't flip. dev-inference simply intercepts text via
 *     priority while it's enabled.
 *
 * Enable it with `DETOUR_DEV_INFERENCE=1` (env or runtime setting). When
 * enabled the plugin's priority is 150 — above codex-chatgpt (100) and the
 * active-LLM-plugin pin (100) — so text turns go to the proxy. When disabled
 * the priority drops below every real provider and the handlers throw, so the
 * dpe-fallback chain ignores it entirely.
 *
 * The endpoint, key and per-tier models are all env-overridable; sane
 * defaults (the shared rotating free-tier key + the proxy's `auto` router
 * model) are baked in so smoke / integration tests are self-contained.
 */

import {
	ModelType,
	logger,
	type GenerateTextParams,
	type IAgentRuntime,
	type Plugin,
} from "@elizaos/core";

// ── Defaults ──────────────────────────────────────────────────────
// Shared free-tier proxy. The key rotates and is intentionally usable for
// dev + tests only; it is gated behind DETOUR_DEV_INFERENCE and never
// touches the user's real OPENAI_* credentials.
export const DEV_INFERENCE_DEFAULT_BASE_URL = "http://localhost:3001/v1";
export const DEV_INFERENCE_DEFAULT_API_KEY =
	"freellmapi-e7ae86a1fafed31bc2158cfc96faa849a46cd93d26e5d376";
/** The proxy's router model — picks the best available free model per call. */
export const DEV_INFERENCE_DEFAULT_MODEL = "auto";

/** Priority while enabled — beats codex-chatgpt (100) and the active-LLM pin (100). */
export const DEV_INFERENCE_PRIORITY = 150;
/** Priority while disabled — below every real provider so it never wins. */
const DEV_INFERENCE_DISABLED_PRIORITY = -1000;

const ENABLE_KEY = "DETOUR_DEV_INFERENCE";
const STREAM_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 2_000;

export interface DevInferenceConfig {
	/** Full base URL including the `/v1` segment, trailing slash stripped. */
	baseUrl: string;
	apiKey: string;
	smallModel: string;
	mediumModel: string;
	largeModel: string;
}

function pickSetting(runtime: IAgentRuntime | undefined, key: string): string | undefined {
	const fromRuntime = runtime?.getSetting?.(key);
	if (typeof fromRuntime === "string" && fromRuntime.trim().length > 0) {
		return fromRuntime.trim();
	}
	const env = process.env[key];
	return typeof env === "string" && env.trim().length > 0 ? env.trim() : undefined;
}

function asBoolean(value: string | undefined): boolean {
	if (!value) return false;
	return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

/** True when dev inference is explicitly enabled via setting/env. */
export function isDevInferenceEnabled(runtime?: IAgentRuntime): boolean {
	return asBoolean(pickSetting(runtime, ENABLE_KEY));
}

/**
 * Resolve the effective dev-inference config (defaults + env/setting
 * overrides). Always returns a usable config regardless of the enable flag —
 * callers gate on `isDevInferenceEnabled` separately, and tests use this to
 * learn the endpoint they should hit.
 */
export function resolveDevInferenceConfig(runtime?: IAgentRuntime): DevInferenceConfig {
	const baseUrl = (pickSetting(runtime, "DETOUR_DEV_INFERENCE_URL") ?? DEV_INFERENCE_DEFAULT_BASE_URL)
		.replace(/\/$/, "");
	const apiKey = pickSetting(runtime, "DETOUR_DEV_INFERENCE_API_KEY") ?? DEV_INFERENCE_DEFAULT_API_KEY;
	const model = pickSetting(runtime, "DETOUR_DEV_INFERENCE_MODEL") ?? DEV_INFERENCE_DEFAULT_MODEL;
	return {
		baseUrl,
		apiKey,
		smallModel: pickSetting(runtime, "DETOUR_DEV_INFERENCE_SMALL_MODEL") ?? model,
		mediumModel: pickSetting(runtime, "DETOUR_DEV_INFERENCE_MEDIUM_MODEL") ?? model,
		largeModel: pickSetting(runtime, "DETOUR_DEV_INFERENCE_LARGE_MODEL") ?? model,
	};
}

function modelForType(config: DevInferenceConfig, modelType: string): string {
	if (modelType === ModelType.TEXT_SMALL) return config.smallModel;
	if (modelType === ModelType.TEXT_MEDIUM) return config.mediumModel;
	return config.largeModel;
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
): ((chunk: string, messageId?: string, accumulated?: string) => void) | undefined {
	if (!params || typeof params !== "object") return undefined;
	const p = params as { onStreamChunk?: unknown };
	return typeof p.onStreamChunk === "function"
		? (p.onStreamChunk as (chunk: string, messageId?: string, accumulated?: string) => void)
		: undefined;
}

/** Forward caller `maxTokens` / `temperature` / `stopSequences`; per-tier defaults otherwise. */
function extractSamplingControls(
	params: GenerateTextParams | unknown,
	defaults: { maxTokens: number; temperature: number },
): { maxTokens: number; temperature: number; stopSequences: string[] } {
	const out = { maxTokens: defaults.maxTokens, temperature: defaults.temperature, stopSequences: [] as string[] };
	if (!params || typeof params !== "object") return out;
	const p = params as { maxTokens?: unknown; temperature?: unknown; stopSequences?: unknown };
	if (typeof p.maxTokens === "number" && p.maxTokens > 0) out.maxTokens = Math.floor(p.maxTokens);
	if (typeof p.temperature === "number" && Number.isFinite(p.temperature)) out.temperature = p.temperature;
	if (Array.isArray(p.stopSequences)) {
		out.stopSequences = p.stopSequences.filter((s): s is string => typeof s === "string" && s.length > 0);
	} else if (typeof p.stopSequences === "string" && p.stopSequences.length > 0) {
		out.stopSequences = [p.stopSequences];
	}
	return out;
}

interface ChatOptions {
	maxTokens?: number;
	temperature?: number;
	stopSequences?: string[];
	onStreamChunk?: (chunk: string, messageId?: string, accumulated?: string) => void;
}

/**
 * OpenAI-compatible /chat/completions call against the proxy. Streams when
 * `onStreamChunk` is provided (so eliza's planner reacts to deltas live);
 * collects + returns the full text either way. A `model` field is always
 * sent — the proxy requires it (defaults to its `auto` router).
 */
export async function callDevInferenceChat(
	config: DevInferenceConfig,
	model: string,
	prompt: string,
	options: ChatOptions = {},
): Promise<string> {
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), STREAM_TIMEOUT_MS);
	try {
		const stream = typeof options.onStreamChunk === "function";
		const body: Record<string, unknown> = {
			model,
			messages: [{ role: "user", content: prompt }],
			stream,
		};
		if (typeof options.maxTokens === "number" && options.maxTokens > 0) body.max_tokens = Math.floor(options.maxTokens);
		if (typeof options.temperature === "number") body.temperature = options.temperature;
		if (options.stopSequences && options.stopSequences.length > 0) body.stop = options.stopSequences;
		const res = await fetch(`${config.baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${config.apiKey}`,
			},
			body: JSON.stringify(body),
			signal: ctl.signal,
		});
		if (!res.ok) {
			throw new Error(`dev-inference HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
		}
		if (!stream) {
			const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
			return data.choices?.[0]?.message?.content ?? "";
		}
		const reader = res.body?.getReader();
		if (!reader) throw new Error("dev-inference stream missing body reader");
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
						const json = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
						const delta = json.choices?.[0]?.delta?.content ?? "";
						if (delta) {
							collected += delta;
							cb(delta, undefined, collected);
						}
					} catch {
						// Proxies sometimes emit partial JSON or keep-alive lines; ignore.
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
 * Lightweight reachability probe — GET /models with a short timeout. Used by
 * smoke / integration tests to skip cleanly when the proxy isn't running
 * (e.g. CI), rather than failing red.
 */
export async function probeDevInferenceReachable(
	config: DevInferenceConfig,
	timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> {
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), timeoutMs);
	try {
		const res = await fetch(`${config.baseUrl}/models`, {
			headers: { Authorization: `Bearer ${config.apiKey}` },
			signal: ctl.signal,
		});
		return res.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

const DEFAULT_MAX_TOKENS: Record<string, number> = {
	[ModelType.TEXT_SMALL]: 512,
	[ModelType.TEXT_MEDIUM]: 1024,
	[ModelType.TEXT_LARGE]: 2048,
};

function makeTextHandler(modelType: string) {
	return async (runtime: IAgentRuntime, params: GenerateTextParams | string): Promise<string> => {
		if (!isDevInferenceEnabled(runtime)) {
			throw new Error(
				`dev-inference: ${ENABLE_KEY} not enabled — falling through to next provider`,
			);
		}
		const config = resolveDevInferenceConfig(runtime);
		const prompt = extractPromptText(params);
		if (!prompt) return "";
		const onStreamChunk = extractStreamCallback(params);
		const controls = extractSamplingControls(params, {
			maxTokens: DEFAULT_MAX_TOKENS[modelType] ?? 1024,
			temperature: 0.7,
		});
		try {
			return await callDevInferenceChat(config, modelForType(config, modelType), prompt, {
				...controls,
				...(onStreamChunk ? { onStreamChunk } : {}),
			});
		} catch (err) {
			logger.warn(
				{ src: "dev-inference", modelType, err: err instanceof Error ? err.message : String(err) },
				`dev-inference ${modelType} call failed`,
			);
			throw err;
		}
	};
}

export const devInferencePlugin: Plugin = {
	name: "dev-inference",
	description:
		"Dev-only TEXT_SMALL/MEDIUM/LARGE handler routing to an OpenAI-compatible free proxy (default http://localhost:3001/v1). Enabled with DETOUR_DEV_INFERENCE=1; priority 150 outranks cloud providers while on, otherwise inert. Never touches OPENAI_* / embeddings / the active provider.",
	// Intentionally a dynamic getter (read at handler-registration time), not a
	// static field — the enable flag toggles it. dev-inference.test.ts pins this.
	get priority() {
		return isDevInferenceEnabled() ? DEV_INFERENCE_PRIORITY : DEV_INFERENCE_DISABLED_PRIORITY;
	},
	models: {
		[ModelType.TEXT_SMALL]: makeTextHandler(ModelType.TEXT_SMALL),
		[ModelType.TEXT_MEDIUM]: makeTextHandler(ModelType.TEXT_MEDIUM),
		[ModelType.TEXT_LARGE]: makeTextHandler(ModelType.TEXT_LARGE),
	},
};

export default devInferencePlugin;
