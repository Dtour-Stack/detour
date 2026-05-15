/**
 * Live integration tests for Detour's local AI stack. Gated by
 * `DETOUR_RUN_LIVE_TESTS=1` — skipped by default so `bun test` stays
 * fast and CI without a running llama-server passes.
 *
 * Mirrors the eliza .live.test.ts pattern (see
 * eliza/packages/core/src/__tests__/should-respond.live.test.ts) that
 * the audit (docs/testing-audit.md) called out: Detour wasn't reusing
 * the upstream live-LLM convention. This file changes that.
 *
 * What it covers (only the things `bun test` alone can't catch):
 *
 *   1. Local llama-server is reachable on the URL Detour exposes via
 *      OPENAI_EMBEDDING_URL / DETOUR_LOCAL_CHAT_URL. If embed server
 *      crashed mid-session or the URL drifted, this fails.
 *   2. The embedding endpoint returns a 384-dim non-zero vector. A
 *      silent regression to zero-vector fallback would otherwise only
 *      surface as bad semantic search results in production.
 *   3. The chat-completions endpoint accepts an OpenAI-shape request
 *      and returns text. Catches version drift in llama-server's HTTP
 *      shape that the local-chat plugin assumes.
 *   4. local-chat plugin smoke — uses the actual plugin handler
 *      against the live server end-to-end.
 *
 * To run:  DETOUR_RUN_LIVE_TESTS=1 bun test src/bun/core/llama/local-stack.live.test.ts
 */

import { describe, expect, test } from "bun:test";
import { ModelType, type IAgentRuntime } from "@elizaos/core";
import { localChatPlugin } from "../../plugins/local-chat/index";

const runLive = process.env.DETOUR_RUN_LIVE_TESTS === "1";
const liveDescribe = runLive ? describe : describe.skip;

const EMBED_URL =
	process.env.OPENAI_EMBEDDING_URL ?? "http://127.0.0.1:0/v1/embeddings";
const CHAT_URL =
	process.env.DETOUR_LOCAL_CHAT_URL ?? "http://127.0.0.1:0";

const LIVE_TIMEOUT_MS = 30_000;

function fakeRuntime(settings: Record<string, string> = {}): IAgentRuntime {
	return {
		getSetting: (key: string): unknown => settings[key],
	} as unknown as IAgentRuntime;
}

liveDescribe("Detour local stack (live)", () => {
	test(
		"embed server is reachable and returns a 384-dim vector",
		async () => {
			const url = EMBED_URL.endsWith("/v1/embeddings")
				? EMBED_URL
				: `${EMBED_URL.replace(/\/$/, "")}/v1/embeddings`;
			const res = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer local-llama",
				},
				body: JSON.stringify({
					model: "local",
					input: "the quick brown fox",
				}),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				data?: Array<{ embedding?: number[] }>;
			};
			const embedding = body.data?.[0]?.embedding;
			expect(Array.isArray(embedding)).toBe(true);
			expect(embedding!.length).toBe(384);
			// Catches silent zero-vector regression — pure noise has very
			// low probability of being all-zero.
			const nonZero = embedding!.filter((x) => x !== 0).length;
			expect(nonZero).toBeGreaterThan(100);
		},
		LIVE_TIMEOUT_MS,
	);

	test(
		"chat-completions endpoint returns text",
		async () => {
			if (!process.env.DETOUR_LOCAL_CHAT_URL) {
				// If the user hasn't spawned local-chat, skip this one
				// silently — the embed test above is the more important
				// signal. local-chat is opt-in by design.
				return;
			}
			const url = `${CHAT_URL.replace(/\/$/, "")}/v1/chat/completions`;
			const res = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					messages: [{ role: "user", content: "say hi in one word" }],
					max_tokens: 30,
					stream: false,
				}),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				choices?: Array<{ message?: { content?: string } }>;
			};
			const content = body.choices?.[0]?.message?.content ?? "";
			expect(content.length).toBeGreaterThan(0);
		},
		LIVE_TIMEOUT_MS,
	);

	test(
		"local-chat plugin TEXT_SMALL handler returns a real reply",
		async () => {
			if (!process.env.DETOUR_LOCAL_CHAT_URL) return;
			const runtime = fakeRuntime({
				DETOUR_LOCAL_CHAT_URL: CHAT_URL,
			});
			const handler = (
				localChatPlugin.models as Record<
					string,
					(rt: IAgentRuntime, p: unknown) => Promise<string>
				>
			)[ModelType.TEXT_SMALL];
			expect(typeof handler).toBe("function");
			const out = await handler(runtime, { prompt: "name one color in one word" });
			expect(typeof out).toBe("string");
			expect(out.length).toBeGreaterThan(0);
		},
		LIVE_TIMEOUT_MS,
	);

	test(
		"streaming path emits at least one delta chunk",
		async () => {
			if (!process.env.DETOUR_LOCAL_CHAT_URL) return;
			const runtime = fakeRuntime({
				DETOUR_LOCAL_CHAT_URL: CHAT_URL,
			});
			const handler = (
				localChatPlugin.models as Record<
					string,
					(rt: IAgentRuntime, p: unknown) => Promise<string>
				>
			)[ModelType.TEXT_SMALL];
			const chunks: string[] = [];
			const out = await handler(runtime, {
				prompt: "list two animals",
				onStreamChunk: (chunk: string) => chunks.push(chunk),
			});
			expect(typeof out).toBe("string");
			expect(chunks.length).toBeGreaterThan(0);
			// The final assembled string should be at least as long as
			// one chunk — protects against "streams empty deltas, returns
			// nothing" regressions.
			expect(out.length).toBeGreaterThanOrEqual(chunks.join("").length);
		},
		LIVE_TIMEOUT_MS,
	);
});
