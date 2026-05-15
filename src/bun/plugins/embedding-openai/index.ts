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
 *   - OPENAI_EMBEDDING_MAX_CHARS (optional, default 960) — char-budget for
 *     pre-emptive truncation. 960 chars maps to ~480 tokens for typical
 *     mixed content, which keeps requests safely under the local llama
 *     server's 512-token batch (`--ctx-size 512`, the bge-small training
 *     max). Override if you're targeting cloud OpenAI with 8k+ context.
 *
 * Sizing strategy (when the local llama server is the target):
 *   - bge-small-en is trained on a 512-token sequence — anything beyond
 *     that is wasted at the *model* level, and the *server* rejects
 *     inputs that exceed its physical batch (`ubatch-size`, default = 512)
 *     with HTTP 500 "input (N tokens) is too large to process".
 *   - We truncate the client input pre-emptively to a conservative char
 *     budget, and on a server batch-size error we halve-and-retry instead
 *     of silently substituting a zero vector. Zero is only emitted as a
 *     last resort (no API key, network down, retries exhausted) and is
 *     logged at error level so an operator notices.
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
/**
 * Conservative char-budget that maps to roughly 480 tokens for typical
 * mixed (English prose + code + urls + punctuation) input — comfortably
 * under the local llama server's 512-token batch. Tuned empirically off
 * the observed 2-chars-per-token ratio in agent memories where dense
 * punctuation and short identifiers produce many short tokens.
 */
const DEFAULT_MAX_CHARS = 960;
/**
 * Server-batch-size errors halve the input and retry up to this many
 * extra attempts. Most rejected inputs succeed on the first halving;
 * three attempts handles pathological "all-punctuation" inputs.
 */
const MAX_BATCH_RETRIES = 3;
/** Bail out instead of slicing below this — sub-64-char embeddings are
 *  too lossy to be worth keeping. */
const MIN_RETRY_INPUT_LEN = 64;
const REQUEST_TIMEOUT = 10_000;

/**
 * Recognise the specific class of errors that mean "shrink the input
 * and try again": llama.cpp's `ubatch` rejection, OpenAI's context-length
 * cap, and Cohere-style "max tokens" complaints. We only retry on these
 * — auth, network, and quota errors fail through to the zero-vector
 * fallback so the caller gets a definitive answer fast.
 */
const SHRINKABLE_ERROR_REGEX =
	/input \(\d+ tokens\) is too large|increase the physical batch size|batch[\s_-]?size|context[_\s-]?length|maximum context|too many tokens/i;

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

/**
 * Split `text` into overlapping windows, each ≤ `windowChars`. Tries to
 * break on paragraph / sentence / word boundaries when possible so chunks
 * don't slice through tokens mid-word.
 *
 * Used by the chunk-and-mean-pool path: when an input is too long for the
 * embedding model's batch limit, instead of truncating (losing 90%+ of
 * long planner state), we embed each chunk and average the unit vectors.
 * That preserves semantic coverage across the whole input.
 */
function chunkText(text: string, windowChars: number, overlapChars: number): string[] {
	if (text.length <= windowChars) return [text];
	const chunks: string[] = [];
	const stride = Math.max(1, windowChars - overlapChars);
	let cursor = 0;
	const breakChars = ["\n\n", ". ", "! ", "? ", "\n", ", ", " "];
	while (cursor < text.length) {
		let end = Math.min(cursor + windowChars, text.length);
		if (end < text.length) {
			// Walk backward up to ~25% of the window looking for a clean break.
			const minBreak = end - Math.floor(windowChars * 0.25);
			for (const sep of breakChars) {
				const idx = text.lastIndexOf(sep, end - 1);
				if (idx >= minBreak) {
					end = idx + sep.length;
					break;
				}
			}
		}
		const slice = text.slice(cursor, end).trim();
		if (slice.length > 0) chunks.push(slice);
		if (end >= text.length) break;
		cursor = Math.max(cursor + 1, end - overlapChars);
	}
	return chunks;
}

/**
 * Mean-pool a set of equal-length unit-vector embeddings and re-normalise.
 * Throws on empty/mismatched input rather than returning a meaningless
 * value — the caller should never reach here with no chunks.
 */
function meanPoolNormalized(vectors: number[][]): number[] {
	if (vectors.length === 0) throw new Error("meanPoolNormalized: no vectors");
	const dim = vectors[0]!.length;
	const out = new Array<number>(dim).fill(0);
	for (const v of vectors) {
		if (v.length !== dim) {
			throw new Error(
				`meanPoolNormalized: dim mismatch (expected ${dim}, got ${v.length})`,
			);
		}
		const norm = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0));
		const scale = norm > 0 ? 1 / norm : 0;
		for (let i = 0; i < dim; i += 1) out[i]! += v[i]! * scale;
	}
	for (let i = 0; i < dim; i += 1) out[i]! /= vectors.length;
	const norm = Math.sqrt(out.reduce((acc, x) => acc + x * x, 0));
	const scale = norm > 0 ? 1 / norm : 0;
	for (let i = 0; i < dim; i += 1) out[i]! *= scale;
	return out;
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

			// Chunk-and-mean-pool for long inputs. The local bge-small llama
			// server has a 512-token batch — anything over ~960 chars used to
			// get truncated, throwing away 90%+ of long planner state. Now
			// we embed each window and average the unit vectors so the final
			// embedding reflects the WHOLE input.
			//
			// Hard cap on number of chunks: 8. Beyond that the bottleneck
			// is round-trips, and we'd rather give a coarse-but-fast vector
			// than freeze the planner waiting for 30+ embedding calls.
			const overlapChars = Math.max(32, Math.floor(maxChars * 0.1));
			const chunks = chunkText(text, maxChars, overlapChars).slice(0, 8);
			if (chunks.length > 1) {
				if (!warnedTruncatedInput) {
					warnedTruncatedInput = true;
					logger.info(
						{
							src: "embedding-openai",
							inputChars: text.length,
							maxChars,
							chunkCount: chunks.length,
						},
						"embedding input exceeded batch limit — chunk-and-pool active",
					);
				}
				const vectors: number[][] = [];
				for (const chunk of chunks) {
					try {
						const v = await callOpenAIEmbeddings({
							apiKey,
							url,
							model,
							input: chunk,
							...(dimRaw && Number.isFinite(dim) ? { dimensions: dim } : {}),
						});
						vectors.push(v);
					} catch (err) {
						logger.warn(
							{
								src: "embedding-openai",
								err: err instanceof Error ? err.message : String(err),
								chunkChars: chunk.length,
							},
							"embedding chunk failed — skipping and continuing with remaining chunks",
						);
					}
				}
				if (vectors.length > 0) {
					try {
						return meanPoolNormalized(vectors);
					} catch (err) {
						logger.warn(
							{
								src: "embedding-openai",
								err: err instanceof Error ? err.message : String(err),
							},
							"mean-pool failed — falling through to single-shot path",
						);
					}
				}
				// If every chunk failed, fall through to single-shot path
				// with the first chunk as input. The shrink-and-retry loop
				// inside that path is the last line of defence.
			}

			let input = chunks[0] ?? text.slice(0, maxChars);

			// Retry loop: if the server complains the input is too large for
			// its batch, halve and try again. This is the local llama-server
			// failure mode that previously silently produced zero vectors;
			// halving converges fast (typical recovery in one extra round-trip).
			const attemptErrors: string[] = [];
			for (let attempt = 0; attempt <= MAX_BATCH_RETRIES; attempt += 1) {
				try {
					const vec = await callOpenAIEmbeddings({
						apiKey,
						url,
						model,
						input,
						...(dimRaw && Number.isFinite(dim) ? { dimensions: dim } : {}),
					});
					warnedNoKey = false;
					if (attempt > 0) {
						logger.info(
							{
								src: "embedding-openai",
								attempts: attempt + 1,
								finalInputChars: input.length,
								originalInputChars: text.length,
							},
							"embedding recovered after shrink-and-retry",
						);
					}
					return vec;
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					attemptErrors.push(`attempt ${attempt + 1}: ${msg}`);
					const isShrinkable = SHRINKABLE_ERROR_REGEX.test(msg);
					const canShrink = input.length > MIN_RETRY_INPUT_LEN;
					if (
						isShrinkable
						&& canShrink
						&& attempt < MAX_BATCH_RETRIES
					) {
						const next = Math.max(MIN_RETRY_INPUT_LEN, Math.floor(input.length / 2));
						logger.warn(
							{
								src: "embedding-openai",
								err: msg,
								inputChars: input.length,
								nextInputChars: next,
								attempt: attempt + 1,
							},
							"embedding rejected for batch size — halving input and retrying",
						);
						input = input.slice(0, next);
						continue;
					}
					// Non-retryable, or we've exhausted retries / floor.
					break;
				}
			}

			logger.error(
				{
					src: "embedding-openai",
					attempts: attemptErrors.length,
					errors: attemptErrors,
					originalInputChars: text.length,
					finalInputChars: input.length,
					url,
					model,
				},
				"embedding call failed after retries — returning zero vector (semantic search will degrade)",
			);
			return new Array(dim).fill(0);
		},
	},
};

export default embeddingOpenAIPlugin;
