#!/usr/bin/env bun
/**
 * eliza-routing-test — verifies the unified DETOUR_MODEL_<TYPE>_PROVIDER
 * routing actually steers useModel through the correct plugin.
 *
 * Tests:
 *   1. Set DETOUR_MODEL_TEXT_TO_SPEECH_PROVIDER=local-mlx-tts → useModel
 *      resolves to local-mlx-tts handler and returns audio
 *   2. Set DETOUR_MODEL_TEXT_TO_SPEECH_PROVIDER=elizacloud → local-mlx-tts
 *      throws (not preferred), resolver would fall through to cloud
 *   3. Both legacy LOCAL_MLX_TTS_ENABLED=true and DETOUR_MODEL_*=local-mlx-tts
 *      both correctly enable local
 */

import {
	type IAgentRuntime,
	type JsonValue,
	ModelType,
	type TextToSpeechParams,
} from "@elizaos/core";
import { localMlxTtsPlugin, LocalTtsDisabledError } from "../src/bun/plugins/local-mlx-tts/index";

interface ModelHandler {
	type: string;
	provider: string;
	priority: number;
	handler: (rt: IAgentRuntime, params: Record<string, JsonValue | object>) => Promise<unknown>;
}

function makeFakeRuntime(env: Record<string, string>): { runtime: IAgentRuntime; useModel: (type: string, params: unknown) => Promise<unknown> } {
	const handlers: ModelHandler[] = [];
	const rt: IAgentRuntime = {
		getSetting: (key: string) => env[key],
		registerModel: ((type: string, handler: ModelHandler["handler"], provider: string, priority?: number) => {
			handlers.push({ type, provider, priority: priority ?? 0, handler });
		}) as unknown as IAgentRuntime["registerModel"],
	} as unknown as IAgentRuntime;
	const useModel = async (type: string, params: unknown): Promise<unknown> => {
		const candidates = handlers.filter((h) => h.type === type).sort((a, b) => b.priority - a.priority);
		if (candidates.length === 0) throw new Error(`no handler for ${type}`);
		let lastErr: unknown = null;
		for (const c of candidates) {
			try { return await c.handler(rt, params as Record<string, JsonValue | object>); }
			catch (err) { lastErr = err; }
		}
		throw lastErr;
	};
	return { runtime: rt, useModel };
}

async function test(label: string, env: Record<string, string>, expect: "local-handles" | "local-throws"): Promise<void> {
	console.log(`\n=== ${label} ===`);
	// Plugins read process.env as fallback — set them here too.
	for (const k of Object.keys(env)) process.env[k] = env[k];
	const { runtime, useModel } = makeFakeRuntime(env);
	await localMlxTtsPlugin.init?.({} as Record<string, string>, runtime);
	try {
		const audio = await useModel(ModelType.TEXT_TO_SPEECH, { text: "routing test" } as TextToSpeechParams);
		if (expect !== "local-handles") {
			throw new Error(`expected local to throw, got ${audio?.constructor.name}`);
		}
		const u8 = audio as Uint8Array;
		const magic = String.fromCharCode(...u8.slice(0, 4));
		console.log(`  OK (local handled): ${u8.byteLength} bytes, magic="${magic}"`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (expect === "local-throws" && err instanceof LocalTtsDisabledError) {
			console.log(`  OK (local threw as expected): ${msg}`);
		} else if (expect === "local-throws" && msg.includes("Local TTS disabled")) {
			console.log(`  OK (resolver surfaced expected throw): ${msg}`);
		} else {
			throw err;
		}
	}
}

async function main(): Promise<void> {
	console.log("[routing-test] verifying DETOUR_MODEL_<TYPE>_PROVIDER picker behavior");
	await test(
		"new routing: DETOUR_MODEL_TEXT_TO_SPEECH_PROVIDER=local-mlx-tts → local handles",
		{ DETOUR_MODEL_TEXT_TO_SPEECH_PROVIDER: "local-mlx-tts" },
		"local-handles",
	);
	await test(
		"new routing: DETOUR_MODEL_TEXT_TO_SPEECH_PROVIDER=elizacloud → local throws (would fall to cloud)",
		{ DETOUR_MODEL_TEXT_TO_SPEECH_PROVIDER: "elizacloud" },
		"local-throws",
	);
	await test(
		"legacy: LOCAL_MLX_TTS_ENABLED=true (no DETOUR_MODEL_*) → local handles",
		{ LOCAL_MLX_TTS_ENABLED: "true", DETOUR_MODEL_TEXT_TO_SPEECH_PROVIDER: "" },
		"local-handles",
	);
	await test(
		"legacy: LOCAL_MLX_TTS_ENABLED=false → local throws",
		{ LOCAL_MLX_TTS_ENABLED: "false", DETOUR_MODEL_TEXT_TO_SPEECH_PROVIDER: "" },
		"local-throws",
	);
	console.log("\n[routing-test] ALL PASSED");
	process.exit(0);
}

main().catch((err) => {
	console.error(`[routing-test] FAIL: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
