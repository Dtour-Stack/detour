import { describe, expect, test } from "bun:test";
import {
	CODEX_BASE_URL,
	CODEX_RESPONSES_PATH,
	CodexResponsesClient,
	OPENAI_BETA_HEADER,
} from "./responses-client";

const ACCOUNT_ID = "acct-test-123";
const TOKEN = "tok-abc";

function makeSseStream(events: Array<Record<string, unknown> | string>): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();
	const frames = events.map((e) => (typeof e === "string" ? e : `data: ${JSON.stringify(e)}\n\n`));
	let i = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (i >= frames.length) {
				controller.close();
				return;
			}
			controller.enqueue(enc.encode(frames[i]!));
			i++;
		},
	});
}

describe("CodexResponsesClient", () => {
	test("constructor requires chatgpt_account_id (arg or JWT claim)", () => {
		expect(() => new CodexResponsesClient({ accessToken: "no-claims-token" })).toThrow(/chatgpt_account_id/);
	});

	test("constructor accepts explicit accountId override", () => {
		const c = new CodexResponsesClient({ accessToken: TOKEN, chatgptAccountId: ACCOUNT_ID });
		expect(c).toBeDefined();
	});

	test("create() sends correct URL + headers + body", async () => {
		let captured: { url: string; init: RequestInit } | null = null;
		const mockFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			captured = { url: String(input), init: init ?? {} };
			return new Response(JSON.stringify({ id: "resp-1", output: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;
		const c = new CodexResponsesClient({ accessToken: TOKEN, chatgptAccountId: ACCOUNT_ID, fetchImpl: mockFetch });
		await c.create({ model: "gpt-5.2", instructions: "be brief", input: "hello", stream: false });
		expect(captured).not.toBeNull();
		expect(captured!.url).toBe(`${CODEX_BASE_URL}${CODEX_RESPONSES_PATH}`);
		const headers = new Headers(captured!.init.headers);
		expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
		expect(headers.get("chatgpt-account-id")).toBe(ACCOUNT_ID);
		expect(headers.get("openai-beta")).toBe(OPENAI_BETA_HEADER);
		expect(headers.get("originator")).toBe("codex_cli_rs");
		expect(headers.get("content-type")).toBe("application/json");
		const body = JSON.parse(captured!.init.body as string);
		expect(body.stream).toBe(false);
		expect(body.model).toBe("gpt-5.2");
	});

	test("create() throws with helpful message on non-2xx", async () => {
		const mockFetch: typeof fetch = (async () =>
			new Response(JSON.stringify({ error: { message: "token_invalidated" } }), {
				status: 401,
			})) as unknown as typeof fetch;
		const c = new CodexResponsesClient({ accessToken: TOKEN, chatgptAccountId: ACCOUNT_ID, fetchImpl: mockFetch });
		await expect(c.create({ model: "gpt-5.2", input: "hi" })).rejects.toThrow(/401/);
		await expect(c.create({ model: "gpt-5.2", input: "hi" })).rejects.toThrow(/token_invalidated/);
	});

	test("stream() yields parsed SSE events from data: lines", async () => {
		const events = [
			{ type: "response.created", response: { id: "r-1", status: "in_progress" } },
			{ type: "response.output_text.delta", delta: "Hello" },
			{ type: "response.output_text.delta", delta: " world" },
			{ type: "response.completed", response: { id: "r-1" } },
		];
		const mockFetch: typeof fetch = (async () =>
			new Response(makeSseStream(events), { status: 200 })) as unknown as typeof fetch;
		const c = new CodexResponsesClient({ accessToken: TOKEN, chatgptAccountId: ACCOUNT_ID, fetchImpl: mockFetch });
		const got: string[] = [];
		for await (const ev of c.stream({ model: "gpt-5.2", input: "hi" })) {
			if (ev.type === "response.output_text.delta") got.push((ev as { delta: string }).delta);
		}
		expect(got).toEqual(["Hello", " world"]);
	});

	test("stream() handles fragmented frames split mid-line", async () => {
		const enc = new TextEncoder();
		const fragments = [
			"data: ",
			'{"type":"response.output_text',
			'.delta","delta":"hi"}\n',
			"\n",
			'data: {"type":"response.completed","response":{}}\n\n',
		];
		let i = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (i >= fragments.length) {
					controller.close();
					return;
				}
				controller.enqueue(enc.encode(fragments[i]!));
				i++;
			},
		});
		const mockFetch: typeof fetch = (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;
		const c = new CodexResponsesClient({ accessToken: TOKEN, chatgptAccountId: ACCOUNT_ID, fetchImpl: mockFetch });
		const got: string[] = [];
		for await (const ev of c.stream({ model: "gpt-5.2", input: "hi" })) {
			if (ev.type === "response.output_text.delta") got.push((ev as { delta: string }).delta);
		}
		expect(got).toEqual(["hi"]);
	});

	test("stream() ignores [DONE] terminator + malformed JSON", async () => {
		const enc = new TextEncoder();
		const data = [
			'data: {"type":"response.output_text.delta","delta":"x"}\n\n',
			"data: not-json\n\n",
			"data: [DONE]\n\n",
		].join("");
		const mockFetch: typeof fetch = (async () =>
			new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(data)); c.close(); } }), { status: 200 })) as unknown as typeof fetch;
		const c = new CodexResponsesClient({ accessToken: TOKEN, chatgptAccountId: ACCOUNT_ID, fetchImpl: mockFetch });
		const got: string[] = [];
		for await (const ev of c.stream({ model: "gpt-5.2", input: "hi" })) {
			if (ev.type === "response.output_text.delta") got.push((ev as { delta: string }).delta);
		}
		expect(got).toEqual(["x"]);
	});

	test("stream() rejects on non-2xx", async () => {
		const mockFetch: typeof fetch = (async () =>
			new Response("Unauthorized", { status: 401 })) as unknown as typeof fetch;
		const c = new CodexResponsesClient({ accessToken: TOKEN, chatgptAccountId: ACCOUNT_ID, fetchImpl: mockFetch });
		const iter = c.stream({ model: "gpt-5.2", input: "hi" });
		await expect(iter.next()).rejects.toThrow(/401/);
	});
});
