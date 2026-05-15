/**
 * TOON Compiler — turn whatever the LLM emitted into canonical TOON.
 *
 * elizaOS's structured-output engine expects responses in TOON
 * (Token-Oriented Object Notation, spec: github.com/toon-format/spec).
 * Models in practice emit a grab-bag: JSON, YAML, loose `key: value`
 * lines, markdown-fenced TOON, prose-prefixed TOON. The strict TOON
 * parser rejects most of these and the structured retry loop burns
 * attempts on the same model that's emitting the wrong format.
 *
 * This compiler accepts any of:
 *   - Already-valid TOON          → passes through unchanged
 *   - JSON / JSON5                → re-encodes as canonical TOON
 *   - YAML                        → re-encodes as canonical TOON
 *   - Loose `key: value` lines    → extracts pairs, re-encodes as TOON
 *
 * Output: a string that `parseToonKeyValue` (and the dynamic-prompt
 * engine's own parsers) will accept on the first try.
 *
 * Why a compiler instead of "ask the model nicer":
 *   - Codex CLI (gpt-5.x) keeps drifting back to JSON despite TOON
 *     instructions; the format-following prompt isn't load-bearing.
 *   - Anthropic + ElizaCloud-routed models speak TOON cleanly already.
 *   - Normalizing at the edge means the rest of the runtime sees ONE
 *     format regardless of provider. The dpe-fallback retry chain
 *     stays simple and we don't burn retries on format coercion.
 *
 * Not a goal: validating against a particular schema. The compiler
 * doesn't know what fields the caller wanted — it just produces
 * canonical TOON from any structured input. The structured-output
 * engine still does schema validation on the parsed result.
 */

import { encodeToonValue, parseToonKeyValue } from "@elizaos/core";
import json5 from "json5";
import yaml from "yaml";

export type CompileResult = {
	/** The output string — always either canonical TOON or the original
	 *  text if every parser failed. Always safe to feed to a TOON parser. */
	text: string;
	/** Which format the compiler recognized in the input. "raw" means
	 *  nothing matched and we returned the original text. Useful for
	 *  diagnostics. */
	source: "toon" | "json" | "yaml" | "loose-keys" | "raw";
	/** True if the compiler actually rewrote the input. False if it
	 *  passed through unchanged. */
	rewritten: boolean;
};

const FENCE_REGEX = /^```(?:[a-zA-Z0-9_-]+)?\s*\n?([\s\S]*?)\n?```\s*(?:[\s\S]*)?$/;
const THINK_REGEX = /<think>[\s\S]*?<\/think>/gi;

function stripWrappers(raw: string): string {
	let text = raw.replace(THINK_REGEX, "").trim();
	const fenced = text.match(FENCE_REGEX);
	if (fenced?.[1]) text = fenced[1].trim();
	return text;
}

/**
 * TOON detector. We don't try a full parse here because the strict
 * decoder throws on common drift (missing array lengths, etc.) —
 * instead we look for the unique shape: top-level `key:` lines plus
 * optional `[N]` or `[N]{cols}` tabular headers.
 */
function looksLikeToon(text: string): boolean {
	if (!text) return false;
	const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
	if (lines.length === 0) return false;
	// First non-indented line should be `key:` or `key[N]:` or `key[N]{cols}:`
	const first = lines[0]!.trimStart();
	return /^[a-zA-Z_][a-zA-Z0-9_]*(?:\[\d+\](?:\{[^}]*\})?)?\s*:/.test(first);
}

function tryJson(text: string): unknown {
	try {
		return json5.parse(text);
	} catch {
		// Maybe wrapped in extra text — extract first {...} or [...]
		const jsonMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
		if (!jsonMatch) return null;
		try {
			return json5.parse(jsonMatch[1]!);
		} catch {
			return null;
		}
	}
}

function tryYaml(text: string): unknown {
	try {
		const parsed = yaml.parse(text);
		// Only count it as YAML if we got an object/array — primitives
		// would parse as "yaml" too (`text: hello` is parseable) but that
		// would steal from the loose-keys parser which is more deliberate.
		if (parsed && typeof parsed === "object") return parsed;
		return null;
	} catch {
		return null;
	}
}

/**
 * Pull `key: value` lines out of arbitrary prose. We accept simple
 * single-line values only (no multi-line strings) and assemble them
 * into a flat object. Useful when the model wrote prose with embedded
 * structured-looking fields, or when the structure was destroyed by
 * formatting but the field names survive.
 *
 * Bracketed array syntax `actions: [...]` is split into an array of
 * trimmed comma-separated items so `actions: [REPLY, NONE]` survives.
 */
function tryLooseKeys(text: string): Record<string, unknown> | null {
	const out: Record<string, unknown> = {};
	let found = 0;
	for (const line of text.split(/\r?\n/)) {
		const m = line.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
		if (!m) continue;
		const key = m[1]!;
		const raw = m[2]!.trim();
		if (raw === "") {
			out[key] = "";
			found++;
			continue;
		}
		// Inline bracket array: [a, b, c] or ["a","b"]
		const bracket = raw.match(/^\[(.*)\]$/);
		if (bracket) {
			const inner = bracket[1]!.trim();
			if (inner === "") {
				out[key] = [];
			} else {
				out[key] = inner
					.split(",")
					.map((p) => p.trim().replace(/^["']|["']$/g, ""))
					.filter((p) => p.length > 0);
			}
			found++;
			continue;
		}
		// Booleans
		if (raw === "true" || raw === "false") {
			out[key] = raw === "true";
			found++;
			continue;
		}
		// Number
		if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
			out[key] = Number(raw);
			found++;
			continue;
		}
		// String — strip surrounding quotes if present
		out[key] = raw.replace(/^["'`]|["'`]$/g, "");
		found++;
	}
	return found > 0 ? out : null;
}

function safeEncodeToon(value: unknown): string | null {
	try {
		return encodeToonValue(value);
	} catch {
		return null;
	}
}

/**
 * Re-emit canonical TOON from a TOON input. The validate-and-
 * normalize path: if the input already parses, round-trip through
 * decode→encode so subtle drift (mixed indentation, trailing
 * whitespace, missing `[N]` length) gets fixed and the downstream
 * parser sees an idiomatic doc.
 */
function tryRoundTripToon(text: string): string | null {
	try {
		const decoded = parseToonKeyValue(text);
		if (decoded === null || decoded === undefined) return null;
		return encodeToonValue(decoded);
	} catch {
		return null;
	}
}

/**
 * Main entry: turn any structured-ish text into canonical TOON.
 * Always returns a string — falls back to the input unchanged when
 * no parser recognizes the content.
 */
export function compileToToon(raw: string): CompileResult {
	if (!raw || raw.trim() === "") {
		return { text: raw, source: "raw", rewritten: false };
	}
	const stripped = stripWrappers(raw);

	// 1. Already valid TOON — round-trip to normalize.
	if (looksLikeToon(stripped)) {
		const normalized = tryRoundTripToon(stripped);
		if (normalized !== null) {
			return { text: normalized, source: "toon", rewritten: normalized !== stripped };
		}
		// Strict decode failed but it looks like TOON — pass through
		// stripped (sanitized) for the loose parser to try.
		return { text: stripped, source: "toon", rewritten: stripped !== raw };
	}

	// 2. JSON / JSON5
	const jsonValue = tryJson(stripped);
	if (jsonValue !== null && typeof jsonValue === "object") {
		const toon = safeEncodeToon(jsonValue);
		if (toon !== null) {
			return { text: toon, source: "json", rewritten: true };
		}
	}

	// 3. YAML — only if it parses to an object/array.
	const yamlValue = tryYaml(stripped);
	if (yamlValue !== null) {
		const toon = safeEncodeToon(yamlValue);
		if (toon !== null) {
			return { text: toon, source: "yaml", rewritten: true };
		}
	}

	// 4. Loose key: value extraction.
	const loose = tryLooseKeys(stripped);
	if (loose !== null) {
		const toon = safeEncodeToon(loose);
		if (toon !== null) {
			return { text: toon, source: "loose-keys", rewritten: true };
		}
	}

	// 5. Nothing matched — pass through.
	return { text: stripped, source: "raw", rewritten: stripped !== raw };
}
