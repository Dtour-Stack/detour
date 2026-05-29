import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	AgentRuntime,
	ModelType,
	stringToUuid,
	type GenerateTextParams,
} from "@elizaos/core";
import {
	devInferencePlugin,
	probeDevInferenceReachable,
	resolveDevInferenceConfig,
} from "./index";

/**
 * REAL integration test — exercises the full eliza model-resolution path the
 * running app uses: a live AgentRuntime resolves `useModel(TEXT_LARGE)` to the
 * dev-inference plugin, which calls the proxy over HTTP and returns real text.
 *
 * Uses ALLOW_NO_DATABASE (same pattern as runtime-llm-plugin-priority.test.ts)
 * so no PGlite/keychain is needed. Skips cleanly when the proxy is unreachable.
 */

const config = resolveDevInferenceConfig();
const REACHABLE = await probeDevInferenceReachable(config, 6_000);

if (!REACHABLE) {
	// eslint-disable-next-line no-console
	console.warn(
		`[dev-inference.integration] proxy at ${config.baseUrl} unreachable — skipping real integration tests`,
	);
}

async function buildRuntime(): Promise<AgentRuntime> {
	const runtime = new AgentRuntime({
		agentId: stringToUuid("dev-inference-integration"),
		character: { name: "DevInferenceProbe", bio: ["probe"] },
		plugins: [devInferencePlugin],
		settings: { ALLOW_NO_DATABASE: "true", DETOUR_DEV_INFERENCE: "1" },
	});
	await runtime.initialize({ allowNoDatabase: true });
	return runtime;
}

let savedFlag: string | undefined;
beforeAll(() => {
	// The plugin's priority getter reads process.env (no runtime in scope), so
	// the flag must be live in the env before the runtime registers handlers.
	savedFlag = process.env.DETOUR_DEV_INFERENCE;
	process.env.DETOUR_DEV_INFERENCE = "1";
});
afterAll(() => {
	if (savedFlag === undefined) delete process.env.DETOUR_DEV_INFERENCE;
	else process.env.DETOUR_DEV_INFERENCE = savedFlag;
});

describe.skipIf(!REACHABLE)("dev-inference — real AgentRuntime useModel", () => {
	test("useModel(TEXT_LARGE) routes through the plugin to the proxy and returns text", async () => {
		const runtime = await buildRuntime();
		try {
			const out = await runtime.useModel(ModelType.TEXT_LARGE, {
				prompt: "Reply with the single word: PONG",
				maxTokens: 16,
				temperature: 0,
			} as unknown as GenerateTextParams);
			expect(typeof out).toBe("string");
			expect((out as string).trim().length).toBeGreaterThan(0);
		} finally {
			await runtime.stop().catch(() => undefined);
		}
	}, 45_000);

	// Core's useModel strips `onStreamChunk` from params (runtime.ts) and only
	// streams via its own context for handlers that return a TextStreamResult.
	// Our plugin returns a collected string (same posture as local-chat), so
	// streaming is validated at the handler layer the runtime actually invokes:
	// resolve the enable flag + config from the real runtime, then stream.
	test("TEXT_LARGE handler streams deltas when given onStreamChunk (real runtime + proxy)", async () => {
		const runtime = await buildRuntime();
		const handler = devInferencePlugin.models?.[ModelType.TEXT_LARGE];
		expect(handler).toBeDefined();
		const chunks: string[] = [];
		try {
			const out = (await handler!(runtime, {
				prompt: "Count slowly: one, two, three.",
				maxTokens: 48,
				temperature: 0,
				onStreamChunk: (delta: string) => {
					chunks.push(delta);
				},
			} as unknown as GenerateTextParams)) as string;
			expect(chunks.length).toBeGreaterThan(0);
			expect(out.trim().length).toBeGreaterThan(0);
			expect(out).toBe(chunks.join(""));
		} finally {
			await runtime.stop().catch(() => undefined);
		}
	}, 45_000);
});
