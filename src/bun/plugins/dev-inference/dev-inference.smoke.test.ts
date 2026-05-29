import { describe, expect, test } from "bun:test";
import {
	callDevInferenceChat,
	probeDevInferenceReachable,
	resolveDevInferenceConfig,
} from "./index";

/**
 * REAL smoke test — hits the configured dev-inference proxy directly over
 * HTTP. This is the "does the endpoint + key actually work" check the user
 * asked for. It uses the same config resolution the plugin uses, so it also
 * guards against the baked defaults drifting from a working endpoint.
 *
 * Skips (stays green) when the proxy is unreachable so CI without the proxy
 * doesn't fail. Run the proxy locally and `bun test` to exercise it for real.
 */

const config = resolveDevInferenceConfig();
const REACHABLE = await probeDevInferenceReachable(config, 6_000);

if (!REACHABLE) {
	// eslint-disable-next-line no-console
	console.warn(
		`[dev-inference.smoke] proxy at ${config.baseUrl} unreachable — skipping real smoke tests`,
	);
}

describe.skipIf(!REACHABLE)("dev-inference proxy — real HTTP smoke", () => {
	test("GET /models returns a non-empty model list", async () => {
		const res = await fetch(`${config.baseUrl}/models`, {
			headers: { Authorization: `Bearer ${config.apiKey}` },
		});
		expect(res.ok).toBe(true);
		const body = (await res.json()) as { data?: Array<{ id?: string }> };
		expect(Array.isArray(body.data)).toBe(true);
		expect((body.data?.length ?? 0)).toBeGreaterThan(0);
	}, 20_000);

	test("non-streaming chat completion returns real text", async () => {
		const out = await callDevInferenceChat(config, config.largeModel, "Reply with the single word: PONG", {
			maxTokens: 16,
			temperature: 0,
		});
		expect(typeof out).toBe("string");
		expect(out.trim().length).toBeGreaterThan(0);
	}, 45_000);

	test("streaming chat completion delivers deltas and a non-empty final string", async () => {
		const chunks: string[] = [];
		const out = await callDevInferenceChat(config, config.largeModel, "Count slowly: one, two, three.", {
			maxTokens: 48,
			temperature: 0,
			onStreamChunk: (delta) => {
				chunks.push(delta);
			},
		});
		expect(chunks.length).toBeGreaterThan(0);
		expect(out.trim().length).toBeGreaterThan(0);
		// The collected return value equals the concatenation of streamed deltas.
		expect(out).toBe(chunks.join(""));
	}, 45_000);
});
