#!/usr/bin/env bun
/**
 * mlx-stt-smoke — focused STT verification against the production
 * Detour.app socket. First run will trigger the macOS SFSpeechRecognizer
 * TCC consent dialog (because the prod .app's Info.plist now declares
 * NSSpeechRecognitionUsageDescription). After you click Allow, subsequent
 * runs work without prompting.
 *
 * Recursive verification: takes the most-recent TTS-generated AIFF
 * under ~/.detour/, sends it through STT, and reports the transcribed
 * text + similarity to the known TTS input string.
 *
 * Prereq: Detour.app (production build) running.
 */

import { mlxRpc } from "../src/bun/core/mlx-rpc-client";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DETOUR_HOME = join(homedir(), ".detour");

function findMostRecentAiff(): string | null {
	if (!existsSync(DETOUR_HOME)) return null;
	const entries = readdirSync(DETOUR_HOME)
		.filter((n) => /(?:smoke-tts|mlx-verify-omni-tts)-.*\.aiff$/.test(n))
		.map((n) => {
			const p = join(DETOUR_HOME, n);
			return { p, mtime: statSync(p).mtimeMs };
		})
		.sort((a, b) => b.mtime - a.mtime);
	return entries[0]?.p ?? null;
}

async function main(): Promise<void> {
	const aiff = findMostRecentAiff();
	if (!aiff) {
		console.error("[stt-smoke] no AIFF found — run mlx-socket-smoke first to produce one");
		process.exit(1);
	}
	console.log(`[stt-smoke] using audio: ${aiff}`);
	const audioBytes = readFileSync(aiff);
	console.log(`[stt-smoke] ${audioBytes.byteLength} bytes`);

	// Health check first to confirm we're talking to the production socket.
	const health = await mlxRpc.health();
	console.log(`[stt-smoke] connected: availability=${health.availability} headroom=${health.memory.headroomGB.toFixed(1)}GB`);

	console.log("\n[stt-smoke] calling mlx.stt.transcribe — first call triggers macOS Speech Recognition permission dialog.");
	console.log("           If the dialog appears, click ALLOW to grant Detour speech recognition access.");
	console.log("           Re-run this script after granting if it errors with denied/notDetermined.\n");

	try {
		const result = await mlxRpc.transcribe({
			presetId: "apple-speech",
			audioBase64: audioBytes.toString("base64"),
			mimeType: "audio/aiff",
			languageCode: "en-US",
		});
		console.log("=== STT RESULT ===");
		console.log(`  text:     "${result.text}"`);
		console.log(`  language: ${result.language}`);
		console.log(`  segments: ${result.segments.length}`);
		console.log(`  duration: ${result.durationMs}ms`);
		console.log(`  model:    ${result.model}`);
		// Recursive verification: compare against the canonical TTS input strings.
		const candidates = [
			"Hello from Detour. This audio just round-tripped through the MLX socket.",
			"Hello from Detour. The omni agent has its voice now.",
			"hello world",
		];
		const got = result.text.toLowerCase();
		const matches = candidates.map((c) => {
			const a = new Set(c.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
			const b = new Set(got.split(/\W+/).filter((w) => w.length > 2));
			const inter = [...a].filter((w) => b.has(w)).length;
			const union = new Set([...a, ...b]).size;
			return { candidate: c, score: union === 0 ? 0 : inter / union };
		}).sort((x, y) => y.score - x.score);
		console.log(`\n  best match against known TTS inputs: "${matches[0]?.candidate}" → ${((matches[0]?.score ?? 0) * 100).toFixed(0)}% similarity`);
		if ((matches[0]?.score ?? 0) >= 0.4) {
			console.log(`\n[stt-smoke] PASS — round-trip preserves semantic content`);
			process.exit(0);
		} else {
			console.log(`\n[stt-smoke] OK but similarity low — transcription may be inaccurate or audio doesn't match known inputs`);
			process.exit(0);
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`\n[stt-smoke] FAIL: ${msg}`);
		if (msg.includes("Speech recognition not authorized") || msg.includes("permissionDenied")) {
			console.error(`\n  → Open System Settings → Privacy & Security → Speech Recognition`);
			console.error(`    and toggle Detour on. Then re-run this script.`);
		}
		process.exit(1);
	}
}

main();
