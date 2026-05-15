/**
 * local-chat plugin contract tests.
 *
 * - Throws when DETOUR_LOCAL_CHAT_URL is unset (so the dpe-fallback
 *   chain knows to skip it and try the next provider).
 * - Forwards prompts to the configured URL and parses non-streaming
 *   responses cleanly.
 * - Streams when onStreamChunk is provided.
 * - Priority flips with DETOUR_LOCAL_CHAT_PRIMARY.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { localChatPlugin } from "./index";

type GenerateFn = (runtime: unknown, params: unknown) => Promise<string>;

function getHandler(modelType: string): GenerateFn {
	const fn = (localChatPlugin.models as Record<string, GenerateFn>)[modelType];
	if (typeof fn !== "function")
		throw new Error(`no handler for ${modelType}`);
	return fn;
}

function fakeRuntime(settings: Record<string, string> = {}): unknown {
	return {
		getSetting: (key: string) => settings[key],
	};
}

const origEnv = { ...process.env };
afterEach(() => {
	for (const k of Object.keys(process.env)) {
		if (!(k in origEnv)) delete process.env[k];
	}
	Object.assign(process.env, origEnv);
});

describe("local-chat plugin", () => {
	test("throws when DETOUR_LOCAL_CHAT_URL is unset (so fallback chain skips it)", async () => {
		delete process.env.DETOUR_LOCAL_CHAT_URL;
		const handler = getHandler("TEXT_SMALL");
		await expect(
			handler(fakeRuntime(), { prompt: "hi" }),
		).rejects.toThrow(/DETOUR_LOCAL_CHAT_URL/);
	});

	test("priority is 5 by default (below cloud providers)", () => {
		delete process.env.DETOUR_LOCAL_CHAT_PRIMARY;
		expect(localChatPlugin.priority).toBe(5);
	});

	test("priority is 200 when DETOUR_LOCAL_CHAT_PRIMARY=true AND URL is set", () => {
		process.env.DETOUR_LOCAL_CHAT_PRIMARY = "true";
		process.env.DETOUR_LOCAL_CHAT_URL = "http://127.0.0.1:51234";
		expect(localChatPlugin.priority).toBe(200);
	});

	test("priority falls back to 5 when PRIMARY=true but URL is unset (service not running)", () => {
		// Sticky .env case: user set PRIMARY=true on a previous run, then
		// rebooted without starting local-chat. Without this guard the
		// plugin would win every routing decision and fail every call
		// (DETOUR_LOCAL_CHAT_URL not set) with no fallback chain.
		process.env.DETOUR_LOCAL_CHAT_PRIMARY = "true";
		delete process.env.DETOUR_LOCAL_CHAT_URL;
		expect(localChatPlugin.priority).toBe(5);
	});

	test("priority falls back to 5 when PRIMARY=true but URL is empty/whitespace", () => {
		process.env.DETOUR_LOCAL_CHAT_PRIMARY = "true";
		process.env.DETOUR_LOCAL_CHAT_URL = "   ";
		expect(localChatPlugin.priority).toBe(5);
	});

	test("non-streaming call POSTs to /v1/chat/completions and returns content", async () => {
		const calls: { url: string; body: unknown }[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
			return new Response(
				JSON.stringify({
					choices: [{ message: { content: "Hello from local model." } }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;
		try {
			process.env.DETOUR_LOCAL_CHAT_URL = "http://127.0.0.1:51100";
			const handler = getHandler("TEXT_SMALL");
			const out = await handler(fakeRuntime(), { prompt: "Say hi" });
			expect(out).toBe("Hello from local model.");
			expect(calls.length).toBe(1);
			expect(calls[0]!.url).toBe(
				"http://127.0.0.1:51100/v1/chat/completions",
			);
			const body = calls[0]!.body as {
				messages: Array<{ role: string; content: string }>;
				stream: boolean;
			};
			expect(body.messages[0]?.content).toBe("Say hi");
			expect(body.stream).toBe(false);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("streaming call invokes onStreamChunk per SSE delta + returns assembled text", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			const stream = new ReadableStream({
				start(controller) {
					const enc = new TextEncoder();
					const push = (obj: unknown) =>
						controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n`));
					push({ choices: [{ delta: { content: "Hello" } }] });
					push({ choices: [{ delta: { content: " " } }] });
					push({ choices: [{ delta: { content: "world" } }] });
					controller.enqueue(enc.encode("data: [DONE]\n"));
					controller.close();
				},
			});
			return new Response(stream, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as unknown as typeof globalThis.fetch;
		try {
			process.env.DETOUR_LOCAL_CHAT_URL = "http://127.0.0.1:51100";
			const deltas: string[] = [];
			const handler = getHandler("TEXT_MEDIUM");
			const out = await handler(fakeRuntime(), {
				prompt: "Say hi",
				onStreamChunk: (chunk: string) => {
					deltas.push(chunk);
				},
			});
			expect(out).toBe("Hello world");
			expect(deltas).toEqual(["Hello", " ", "world"]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("propagates HTTP error so caller can fall through to next provider", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response("server unhappy", { status: 500 })) as unknown as typeof globalThis.fetch;
		try {
			process.env.DETOUR_LOCAL_CHAT_URL = "http://127.0.0.1:51100";
			const handler = getHandler("TEXT_SMALL");
			await expect(handler(fakeRuntime(), { prompt: "hi" })).rejects.toThrow(
				/HTTP 500/,
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("completion mode routes to /v1/completions with Q:/A: scaffold (base eliza-1 path)", async () => {
		const calls: { url: string; body: unknown }[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
			return new Response(
				JSON.stringify({ choices: [{ text: " 4." }] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;
		try {
			process.env.DETOUR_LOCAL_CHAT_URL = "http://127.0.0.1:51100";
			process.env.DETOUR_LOCAL_CHAT_MODE = "completion";
			const handler = getHandler("TEXT_SMALL");
			const out = await handler(fakeRuntime(), { prompt: "What is 2+2?" });
			expect(out).toBe("4.");
			expect(calls[0]!.url).toBe(
				"http://127.0.0.1:51100/v1/completions",
			);
			const body = calls[0]!.body as { prompt: string; stop: string[] };
			expect(body.prompt).toContain("Q: What is 2+2?");
			expect(body.prompt).toContain("\nA:");
			expect(body.stop).toContain("Q:");
		} finally {
			delete process.env.DETOUR_LOCAL_CHAT_MODE;
			globalThis.fetch = originalFetch;
		}
	});

	test("forwards caller maxTokens / temperature / stopSequences to /v1/chat/completions body", async () => {
		// Regression: the handlers previously hardcoded maxTokens (512/1024/2048)
		// and temperature (0.7) and dropped stopSequences entirely. A planner
		// asking for 100 tokens with stop=["\n\n"] got 512 tokens with no stop
		// and parsers expecting truncated output broke. Pin the new pass-through.
		const calls: { body: Record<string, unknown> }[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({
				body: init?.body ? JSON.parse(init.body as string) : {},
			});
			return new Response(
				JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;
		try {
			delete process.env.DETOUR_LOCAL_CHAT_MODE;
			process.env.DETOUR_LOCAL_CHAT_URL = "http://127.0.0.1:51100";
			const handler = getHandler("TEXT_LARGE");
			await handler(fakeRuntime(), {
				prompt: "hi",
				maxTokens: 77,
				temperature: 0.13,
				stopSequences: ["\n\n", "END"],
			});
			const body = calls[0]!.body;
			expect(body.max_tokens).toBe(77);
			expect(body.temperature).toBeCloseTo(0.13);
			expect(body.stop).toEqual(["\n\n", "END"]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("completion mode merges caller stopSequences with the Q:/A: scaffold stops", async () => {
		const calls: { body: Record<string, unknown> }[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({
				body: init?.body ? JSON.parse(init.body as string) : {},
			});
			return new Response(
				JSON.stringify({ choices: [{ text: "ok" }] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;
		try {
			process.env.DETOUR_LOCAL_CHAT_URL = "http://127.0.0.1:51100";
			process.env.DETOUR_LOCAL_CHAT_MODE = "completion";
			const handler = getHandler("TEXT_SMALL");
			await handler(fakeRuntime(), {
				prompt: "hi",
				stopSequences: ["</xml>"],
			});
			const stop = calls[0]!.body.stop as string[];
			expect(stop).toContain("</xml>");
			expect(stop).toContain("Q:"); // scaffold-required stop preserved
		} finally {
			delete process.env.DETOUR_LOCAL_CHAT_MODE;
			globalThis.fetch = originalFetch;
		}
	});

	test("default mode (no env var) routes to /v1/chat/completions", async () => {
		const calls: { url: string }[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			calls.push({ url });
			return new Response(
				JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;
		try {
			delete process.env.DETOUR_LOCAL_CHAT_MODE;
			process.env.DETOUR_LOCAL_CHAT_URL = "http://127.0.0.1:51100";
			const handler = getHandler("TEXT_SMALL");
			await handler(fakeRuntime(), { prompt: "hi" });
			expect(calls[0]!.url).toBe(
				"http://127.0.0.1:51100/v1/chat/completions",
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
