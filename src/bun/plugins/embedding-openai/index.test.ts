import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { IAgentRuntime, ModelTypeName, TextEmbeddingParams } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { embeddingOpenAIPlugin } from "./index";

/**
 * Wire the plugin's TEXT_EMBEDDING handler against a runtime fixture and
 * a fetch fixture, returning a callable that mirrors how the runtime
 * actually invokes the handler.
 */
function buildHandler(settings: Record<string, string | undefined>) {
	const runtime: IAgentRuntime = {
		getSetting: (key: string) => settings[key],
	} as never;
	const handlerMap = embeddingOpenAIPlugin.models as Record<
		ModelTypeName,
		(rt: IAgentRuntime, p: TextEmbeddingParams | string | null) => Promise<number[]>
	>;
	const handler = handlerMap[ModelType.TEXT_EMBEDDING];
	if (!handler) throw new Error("TEXT_EMBEDDING handler missing");
	return (input: string | TextEmbeddingParams | null) => handler(runtime, input);
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
		...init,
	});
}

/** llama.cpp / OpenAI-compat error envelope. */
function batchTooLargeResponse(tokens = 784): Response {
	return new Response(
		JSON.stringify({
			error: {
				code: 500,
				message: `input (${tokens} tokens) is too large to process. increase the physical batch size (current batch size: 512)`,
				type: "server_error",
			},
		}),
		{ status: 500, headers: { "content-type": "application/json" } },
	);
}

interface FetchCall {
	url: string;
	bodyInput: string;
}

function installFetch(
	responses: Array<Response | ((call: FetchCall) => Response)>,
): { restore: () => void; calls: FetchCall[] } {
	const original = globalThis.fetch;
	const calls: FetchCall[] = [];
	let i = 0;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const parsed = JSON.parse(String(init?.body ?? "{}")) as { input?: unknown };
		const bodyInput = typeof parsed.input === "string" ? parsed.input : "";
		const call: FetchCall = { url, bodyInput };
		calls.push(call);
		const next = responses[i++];
		if (!next) throw new Error("mock fetch ran out of responses");
		return typeof next === "function" ? next(call) : next;
	}) as typeof fetch;
	return { restore: () => { globalThis.fetch = original; }, calls };
}

const KEY_SETTINGS = {
	OPENAI_EMBEDDING_API_KEY: "sk-test",
	OPENAI_EMBEDDING_URL: "http://127.0.0.1:9999/v1/embeddings",
	OPENAI_EMBEDDING_MODEL: "bge-small-test",
};

describe("embeddingOpenAIPlugin TEXT_EMBEDDING handler", () => {
	let cleanup: (() => void) | null = null;

	beforeEach(() => {
		cleanup = null;
	});

	afterEach(() => {
		cleanup?.();
		cleanup = null;
	});

	test("returns the vector from a successful single-shot call", async () => {
		const vec = [0.1, 0.2, 0.3];
		const fixture = installFetch([jsonResponse({ data: [{ embedding: vec }] })]);
		cleanup = fixture.restore;
		const call = buildHandler(KEY_SETTINGS);
		const got = await call("hello world");
		expect(got).toEqual(vec);
		expect(fixture.calls).toHaveLength(1);
	});

	test("halves input and retries on llama-server batch-size error", async () => {
		const vec = [0.5, 0.6];
		const fixture = installFetch([
			batchTooLargeResponse(784),
			jsonResponse({ data: [{ embedding: vec }] }),
		]);
		cleanup = fixture.restore;
		// 900-char input (below the 960 default char cap) so we know the
		// retry-halving (not the up-front truncation) is what shortened it.
		const input = "x".repeat(900);
		const call = buildHandler(KEY_SETTINGS);
		const got = await call(input);
		expect(got).toEqual(vec);
		expect(fixture.calls).toHaveLength(2);
		expect(fixture.calls[0]!.bodyInput.length).toBe(900);
		expect(fixture.calls[1]!.bodyInput.length).toBe(450);
	});

	test("returns zero vector after exhausting batch-size retries", async () => {
		const fixture = installFetch([
			batchTooLargeResponse(),
			batchTooLargeResponse(),
			batchTooLargeResponse(),
			batchTooLargeResponse(),
		]);
		cleanup = fixture.restore;
		const call = buildHandler(KEY_SETTINGS);
		const got = await call("x".repeat(900));
		// 4 attempts: original + 3 retries.
		expect(fixture.calls).toHaveLength(4);
		expect(got).toHaveLength(1536); // default dim
		expect(got.every((n) => n === 0)).toBe(true);
		// Each retry halved the input until the floor.
		expect(fixture.calls[1]!.bodyInput.length).toBeLessThan(fixture.calls[0]!.bodyInput.length);
		expect(fixture.calls[2]!.bodyInput.length).toBeLessThan(fixture.calls[1]!.bodyInput.length);
	});

	test("does not retry on auth errors — falls through to zero vector immediately", async () => {
		const fixture = installFetch([
			new Response(JSON.stringify({ error: { message: "invalid_api_key" } }), { status: 401 }),
		]);
		cleanup = fixture.restore;
		const call = buildHandler(KEY_SETTINGS);
		const got = await call("hello");
		expect(fixture.calls).toHaveLength(1);
		expect(got.every((n) => n === 0)).toBe(true);
	});

	test("respects OPENAI_EMBEDDING_DIMENSIONS for the zero-vector fallback shape", async () => {
		const fixture = installFetch([
			new Response("", { status: 500 }),
		]);
		cleanup = fixture.restore;
		const call = buildHandler({ ...KEY_SETTINGS, OPENAI_EMBEDDING_DIMENSIONS: "384" });
		const got = await call("hello");
		expect(got).toHaveLength(384);
	});

	test("returns zero vector without calling the API when no key is configured", async () => {
		const fixture = installFetch([]);
		cleanup = fixture.restore;
		const call = buildHandler({ ...KEY_SETTINGS, OPENAI_EMBEDDING_API_KEY: undefined });
		const got = await call("hello");
		expect(fixture.calls).toHaveLength(0);
		expect(got.every((n) => n === 0)).toBe(true);
	});

	test("truncates inputs above OPENAI_EMBEDDING_MAX_CHARS before the first call", async () => {
		const vec = [0.9];
		const fixture = installFetch([jsonResponse({ data: [{ embedding: vec }] })]);
		cleanup = fixture.restore;
		const call = buildHandler({ ...KEY_SETTINGS, OPENAI_EMBEDDING_MAX_CHARS: "200" });
		const input = "y".repeat(5000);
		await call(input);
		expect(fixture.calls[0]!.bodyInput.length).toBe(200);
	});
});
