/**
 * Minimal OpenAI-embeddings-only plugin for Detour.
 *
 * Why this exists separately from `@elizaos/plugin-openai`:
 *   - Codex/ChatGPT subscription handles chat (codex-chatgpt plugin), but
 *     does NOT expose an embeddings endpoint. We need a real embedding
 *     provider to keep semantic memory + RAG working.
 *   - Loading the full `plugin-openai` would override our codex chat
 *     handlers (TEXT_LARGE/MEDIUM/SMALL), since plugin-openai registers
 *     all model types unconditionally.
 *   - This plugin only registers TEXT_EMBEDDING, leaving Codex untouched.
 *
 * Settings:
 *   - OPENAI_EMBEDDING_API_KEY (required) — standard OpenAI sk-… key.
 *     Just for embeddings; doesn't need access to chat models.
 *   - OPENAI_EMBEDDING_MODEL (optional, default "text-embedding-3-small")
 *   - OPENAI_EMBEDDING_URL (optional, default https://api.openai.com/v1/embeddings)
 *   - OPENAI_EMBEDDING_DIMENSIONS (optional) — truncate output to N dims
 *
 * Failure mode: if the API call fails (no key, network error, quota), we
 * return a zero vector. The runtime keeps working (vector search degrades
 * to substring); the calling evaluator just doesn't get useful similarity.
 */

import {
	logger,
	ModelType,
	type IAgentRuntime,
	type Plugin,
	type TextEmbeddingParams,
} from "@elizaos/core";

const DEFAULT_MODEL = "text-embedding-3-small";
const DEFAULT_URL = "https://api.openai.com/v1/embeddings";
const DEFAULT_DIM = 1536; // text-embedding-3-small native dim
const DEFAULT_MAX_CHARS = 1_600;
const REQUEST_TIMEOUT = 10_000;

function pickSetting(runtime: IAgentRuntime, key: string): string | undefined {
	const v = runtime.getSetting(key);
	if (typeof v === "string" && v.length > 0) return v;
	const env = process.env[key];
	if (typeof env === "string" && env.length > 0) return env;
	return undefined;
}

function extractText(params: TextEmbeddingParams | string | null | undefined): string {
	if (!params) return "";
	if (typeof params === "string") return params;
	const text = (params as { text?: unknown }).text;
	if (typeof text === "string") return text;
	return "";
}

function positiveInteger(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function callOpenAIEmbeddings(opts: {
	apiKey: string;
	url: string;
	model: string;
	input: string;
	dimensions?: number;
}): Promise<number[]> {
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT);
	try {
		const body: Record<string, unknown> = {
			model: opts.model,
			input: opts.input,
		};
		if (typeof opts.dimensions === "number" && opts.dimensions > 0) {
			body.dimensions = opts.dimensions;
		}
		const res = await fetch(opts.url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${opts.apiKey}`,
			},
			body: JSON.stringify(body),
			signal: ctl.signal,
		});
		if (!res.ok) {
			const errText = await res.text().catch(() => "");
			throw new Error(`OpenAI embeddings HTTP ${res.status}: ${errText.slice(0, 200)}`);
		}
		const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
		const vec = data.data?.[0]?.embedding;
		if (!Array.isArray(vec)) throw new Error("OpenAI embeddings response missing data[0].embedding");
		return vec;
	} finally {
		clearTimeout(timer);
	}
}

let warnedNoKey = false;
let warnedTruncatedInput = false;

export const embeddingOpenAIPlugin: Plugin = {
	name: "embedding-openai",
	description: "OpenAI text-embedding-3-small (or configured) embeddings, separate from chat provider",
	// Higher priority ensures this plugin's TEXT_EMBEDDING handler wins
	// over the LLM provider's (e.g. OpenRouter's) TEXT_EMBEDDING handler.
	// Without this, plugin registration order determines the winner, and
	// the LLM plugin registers first — sending embedding requests to
	// OpenRouter instead of the local llama-server.
	priority: 10,
	models: {
		[ModelType.TEXT_EMBEDDING]: async (
			runtime: IAgentRuntime,
			params: TextEmbeddingParams | string | null,
		): Promise<number[]> => {
			const apiKey = pickSetting(runtime, "OPENAI_EMBEDDING_API_KEY")
				?? pickSetting(runtime, "OPENAI_API_KEY");
			const model = pickSetting(runtime, "OPENAI_EMBEDDING_MODEL") ?? DEFAULT_MODEL;
			const url = pickSetting(runtime, "OPENAI_EMBEDDING_URL") ?? DEFAULT_URL;
			const dimRaw = pickSetting(runtime, "OPENAI_EMBEDDING_DIMENSIONS");
			const dim = positiveInteger(dimRaw, DEFAULT_DIM);
			const maxChars = positiveInteger(
				pickSetting(runtime, "OPENAI_EMBEDDING_MAX_CHARS"),
				DEFAULT_MAX_CHARS,
			);

			const text = extractText(params);
			if (text.length === 0) return new Array(dim).fill(0);
			const input = text.length > maxChars ? text.slice(0, maxChars) : text;
			if (input.length !== text.length && !warnedTruncatedInput) {
				warnedTruncatedInput = true;
				logger.warn(
					{ src: "embedding-openai", inputChars: text.length, maxChars },
					"embedding input exceeded configured limit — truncating before HTTP request",
				);
			}

			if (!apiKey) {
				if (!warnedNoKey) {
					warnedNoKey = true;
					logger.warn(
						{ src: "embedding-openai" },
						"OPENAI_EMBEDDING_API_KEY not set — returning zero vector. Add an OpenAI API key in Settings → Vault to enable real semantic embeddings.",
					);
				}
				return new Array(dim).fill(0);
			}

			try {
				const vec = await callOpenAIEmbeddings({
					apiKey,
					url,
					model,
					input,
					...(dimRaw && Number.isFinite(dim) ? { dimensions: dim } : {}),
				});
				warnedNoKey = false;
				return vec;
			} catch (err) {
				logger.warn(
					{ src: "embedding-openai", err: err instanceof Error ? err.message : err },
					"embedding call failed — returning zero vector",
				);
				return new Array(dim).fill(0);
			}
		},
	},
};

export default embeddingOpenAIPlugin;
