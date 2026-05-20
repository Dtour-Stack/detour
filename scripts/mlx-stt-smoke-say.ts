#!/usr/bin/env bun
/**
 * Production STT smoke using a known-good standard 16-bit PCM AIFF
 * generated via macOS `say`. Recursive verification: known input text
 * → audio → STT round-trip → similarity check.
 */
import { mlxRpc } from "../src/bun/core/mlx-rpc-client";
import { readFileSync } from "node:fs";

const KNOWN_TEXT = "Hello from Detour. This is a speech recognition test.";
const AIFF = "/Users/home/.detour/smoke-say-test.aiff";

async function main(): Promise<void> {
	const bytes = readFileSync(AIFF);
	console.log(`[stt-smoke] input: ${AIFF} (${bytes.byteLength} bytes)`);
	console.log(`[stt-smoke] known text: "${KNOWN_TEXT}"`);

	const health = await mlxRpc.health();
	console.log(`[stt-smoke] connected: availability=${health.availability}`);

	const result = await mlxRpc.transcribe({
		presetId: "apple-speech",
		audioBase64: bytes.toString("base64"),
		mimeType: "audio/aiff",
		languageCode: "en-US",
	});

	console.log("\n=== STT RESULT ===");
	console.log(`  text:     "${result.text}"`);
	console.log(`  language: ${result.language}`);
	console.log(`  segments: ${result.segments.length}`);
	console.log(`  duration: ${result.durationMs}ms`);
	console.log(`  model:    ${result.model}`);

	const a = new Set(KNOWN_TEXT.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
	const b = new Set(result.text.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
	const inter = [...a].filter((w) => b.has(w)).length;
	const union = new Set([...a, ...b]).size;
	const sim = union === 0 ? 0 : inter / union;
	console.log(`\n  similarity to known input: ${(sim * 100).toFixed(0)}%`);
	if (sim >= 0.5) {
		console.log(`\n[stt-smoke] PASS — recursive verification confirmed`);
		process.exit(0);
	} else {
		console.log(`\n[stt-smoke] LOW SIMILARITY — transcription didn't match well`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(`[stt-smoke] FAIL: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
