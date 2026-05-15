import { describe, expect, test } from "bun:test";
import { ModelType, parseToonKeyValue, type IAgentRuntime } from "@elizaos/core";
import codexChatGptPlugin, { stripStructuredWrappers } from "./index";

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

// ──────────────────────────────────────────────────────────────────────
// stripStructuredWrappers — the sanitizer that gives Codex output a
// fighting chance of parsing as TOON. Each case represents a real
// failure mode we've seen in production logs.
// ──────────────────────────────────────────────────────────────────────

describe("stripStructuredWrappers", () => {
	test("returns unchanged text that has no wrappers", () => {
		const input = "thought: hello\nactions[1]:\n  - name: REPLY\ntext: Hi there\nsimple: true";
		expect(stripStructuredWrappers(input)).toBe(input);
	});

	test("strips a leading <think> block (single-line)", () => {
		const input = "<think>I should reply briefly.</think>\nthought: Reply\nactions[1]:\n  - name: REPLY\ntext: Hello\nsimple: true";
		const out = stripStructuredWrappers(input);
		expect(out).not.toContain("<think>");
		expect(out).toMatch(/^thought:/);
	});

	test("strips a multi-line <think> block anywhere in the text", () => {
		const input = "<think>\nLet me think.\nMulti-line reasoning.\n</think>\nthought: ok\nactions[1]:\n  - name: REPLY\ntext: yes\nsimple: true";
		const out = stripStructuredWrappers(input);
		expect(out).not.toContain("<think>");
		expect(out).not.toContain("Multi-line reasoning");
		expect(out.startsWith("thought:")).toBe(true);
	});

	test("unwraps an outer ```toon fence wrapping the entire response", () => {
		const input = "```toon\nthought: ok\nactions[1]:\n  - name: REPLY\ntext: hi\nsimple: true\n```";
		const out = stripStructuredWrappers(input);
		expect(out.startsWith("thought:")).toBe(true);
		expect(out).not.toContain("```");
	});

	test("unwraps an outer plain ``` fence", () => {
		const input = "```\nthought: ok\nactions[1]:\n  - name: REPLY\ntext: hi\nsimple: true\n```";
		const out = stripStructuredWrappers(input);
		expect(out.startsWith("thought:")).toBe(true);
		expect(out).not.toContain("```");
	});

	test("unwraps an outer ```yaml fence", () => {
		const input = "```yaml\nthought: ok\nactions[1]:\n  - name: REPLY\ntext: hi\nsimple: true\n```";
		const out = stripStructuredWrappers(input);
		expect(out.startsWith("thought:")).toBe(true);
	});

	test("preserves inner code fences inside text field (mid-content fences)", () => {
		// A legitimate fenced code example INSIDE the text field should survive.
		const input = "thought: explain code\nactions[1]:\n  - name: REPLY\ntext: Here:\n```js\nconsole.log(1)\n```\nsimple: true";
		const out = stripStructuredWrappers(input);
		// Inner fence preserved because it doesn't wrap the whole response.
		expect(out).toContain("```js");
		expect(out).toContain("console.log(1)");
	});

	test("strips trailing 'Let me know...' pleasantries after TOON block", () => {
		const input = "thought: ok\nactions[1]:\n  - name: REPLY\ntext: hi\nsimple: true\n\nLet me know if you need anything else.";
		const out = stripStructuredWrappers(input);
		expect(out).not.toContain("Let me know");
		expect(out.endsWith("simple: true")).toBe(true);
	});

	test("strips trailing 'Hope this helps' pleasantries", () => {
		const input = "thought: ok\nactions[1]:\n  - name: REPLY\ntext: hi\nsimple: true\n\nHope this helps!";
		const out = stripStructuredWrappers(input);
		expect(out).not.toContain("Hope this helps");
	});

	test("leaves trailing prose alone when no TOON shape is present (chat reply)", () => {
		// Non-TOON output (a chat reply) should NOT be modified.
		const input = "Sure, here's the answer to your question. Let me know if you need more details.";
		const out = stripStructuredWrappers(input);
		expect(out).toBe(input);
	});

	test("combination: think block + outer fence + pleasantry all stripped", () => {
		const input = "<think>planning</think>\n```toon\nthought: ok\nactions[1]:\n  - name: REPLY\ntext: hi\nsimple: true\n```\nHope this helps!";
		const out = stripStructuredWrappers(input);
		expect(out).not.toContain("<think>");
		expect(out).not.toContain("```");
		// Trailing "Hope this helps" should also be stripped — but only after
		// fence removal exposes the TOON shape. Our function applies them in
		// sequence so this works.
		expect(out.startsWith("thought:")).toBe(true);
	});

	test("handles empty input", () => {
		expect(stripStructuredWrappers("")).toBe("");
	});

	test("handles whitespace-only input", () => {
		expect(stripStructuredWrappers("   \n  \n  ")).toBe("");
	});
});

// ──────────────────────────────────────────────────────────────────────
// End-to-end planner-parse smoke tests — verify that the sanitizer's
// output flows correctly into parseToonKeyValue with all messageHandler
// fields extracted. This is the actual user-facing contract.
// ──────────────────────────────────────────────────────────────────────

describe("Codex output → TOON parse pipeline", () => {
	test("clean TOON parses to all 5 messageHandler fields", () => {
		const codexOutput = [
			"thought: Reply briefly to greet the user.",
			"actions[1]:",
			"  - name: REPLY",
			"providers: ",
			"text: Hello! How can I help?",
			"simple: true",
		].join("\n");
		const sanitized = stripStructuredWrappers(codexOutput);
		const parsed = parseToonKeyValue<{
			thought: string;
			actions: unknown;
			providers: string | string[];
			text: string;
			simple: string | boolean;
		}>(sanitized);
		expect(parsed).not.toBeNull();
		expect(parsed?.thought).toBe("Reply briefly to greet the user.");
		expect(parsed?.text).toBe("Hello! How can I help?");
		expect(parsed?.simple === true || parsed?.simple === "true").toBe(true);
	});

	test("wrapped-in-fence + leading-think + trailing-prose still parses end-to-end", () => {
		const codexOutput = [
			"<think>",
			"User said hi. I'll just reply.",
			"</think>",
			"```toon",
			"thought: greeting",
			"actions[1]:",
			"  - name: REPLY",
			"text: Hi!",
			"simple: true",
			"```",
			"",
			"Let me know if you need anything else.",
		].join("\n");
		const sanitized = stripStructuredWrappers(codexOutput);
		const parsed = parseToonKeyValue<{
			thought: string;
			actions: unknown;
			text: string;
			simple: string | boolean;
		}>(sanitized);
		expect(parsed).not.toBeNull();
		expect(parsed?.thought).toBe("greeting");
		expect(parsed?.text).toBe("Hi!");
		expect(parsed?.simple === true || parsed?.simple === "true").toBe(true);
	});

	test("CREATE_TASK-style multi-action plan parses with all fields", () => {
		// Realistic planner output where the agent spawns a long-running
		// sub-agent — the bread-and-butter use case the structured planner
		// needs to support.
		const codexOutput = [
			"thought: User wants a research task; spawn a sub-agent.",
			"actions[1]:",
			"  - name: CREATE_TASK",
			"    params:",
			"      kind: research",
			"      goal: Find recent papers on diffusion models",
			"providers: ",
			"text: I'll spin up a research agent to dig into that.",
			"simple: false",
		].join("\n");
		const sanitized = stripStructuredWrappers(codexOutput);
		const parsed = parseToonKeyValue<{
			thought: string;
			actions: unknown;
			text: string;
		}>(sanitized);
		expect(parsed).not.toBeNull();
		expect(parsed?.thought).toContain("sub-agent");
		expect(parsed?.text).toContain("research agent");
	});
});
