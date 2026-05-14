import { describe, expect, test } from "bun:test";
import { ModelType, type IAgentRuntime } from "@elizaos/core";
import codexChatGptPlugin from "./index";

const ACCOUNT_ID = "acct-test-123";
const TOKEN = "tok-abc";

function makeSseStream(events: Array<Record<string, unknown> | string>): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();
	const frames = events.map((event) => (typeof event === "string" ? event : `data: ${JSON.stringify(event)}\n\n`));
	let index = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index >= frames.length) {
				controller.close();
				return;
			}
			controller.enqueue(enc.encode(frames[index]!));
			index++;
		},
	});
}

describe("codex-chatgpt plugin", () => {
	test("text models accept response.output_text.done when no deltas arrive", async () => {
		const originalFetch = globalThis.fetch;
		const mockFetch: typeof fetch = (async () =>
			new Response(makeSseStream([
				{ type: "response.output_text.done", text: "done-only output" },
				{ type: "response.completed", response: { id: "resp-1" } },
			]), { status: 200 })) as unknown as typeof fetch;
		globalThis.fetch = mockFetch;
		try {
			const runtime = {
				getSetting: (key: string) =>
					key === "CODEX_OAUTH_TOKEN" ? TOKEN :
					key === "CODEX_CHATGPT_ACCOUNT_ID" ? ACCOUNT_ID :
					undefined,
			} as IAgentRuntime;
			const handler = codexChatGptPlugin.models?.[ModelType.TEXT_SMALL];
			if (typeof handler !== "function") throw new Error("TEXT_SMALL handler missing");

			const text = await handler(runtime, { prompt: "hello" } as never);

			expect(text).toBe("done-only output");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
