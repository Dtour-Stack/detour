import { describe, expect, test } from "bun:test";
import type { ActivityTrajectoryDetail } from "../../shared/index";
import {
	extractActionsTaken,
	extractPrompts,
	extractReply,
	extractRequest,
	extractSimpleView,
	extractThinking,
} from "./trajectory-extractors";

function baseDetail(): ActivityTrajectoryDetail {
	return {
		trajectory: { id: "tj-1", source: "chat", status: "completed", startTime: 1, durationMs: 100 },
		identity: { id: "tj-1" },
		totals: {
			stepCount: 0,
			llmCallCount: 0,
			providerAccessCount: 0,
			actionCount: 0,
			totalPromptTokens: 0,
			totalCompletionTokens: 0,
			totalLatencyMs: 0,
		},
		llmCalls: [],
		providerAccesses: [],
		actions: [],
		steps: [],
		metadata: {},
		rewardComponents: null,
		metrics: {},
		raw: null,
	};
}

describe("trajectory extractors", () => {
	test("extractRequest prefers raw.rootMessage.text", () => {
		const d = baseDetail();
		d.raw = { rootMessage: { text: "make me an app" } };
		d.llmCalls = [
			{ callId: "c1", stepNumber: 1, timestamp: 10, model: "opus", userPrompt: "fallback" },
		];
		expect(extractRequest(d)).toBe("make me an app");
	});

	test("extractRequest falls back to first userPrompt when raw missing", () => {
		const d = baseDetail();
		d.llmCalls = [
			{ callId: "c1", stepNumber: 1, timestamp: 10, model: "opus", userPrompt: "the user said hi" },
		];
		expect(extractRequest(d)).toBe("the user said hi");
	});

	test("extractRequest returns null when nothing available", () => {
		expect(extractRequest(baseDetail())).toBeNull();
	});

	test("extractReply prefers last successful REPLY action's text", () => {
		const d = baseDetail();
		d.actions = [
			{ attemptId: "a1", stepNumber: 1, timestamp: 10, actionName: "REPLY", success: true, result: { text: "first reply" } },
			{ attemptId: "a2", stepNumber: 3, timestamp: 30, actionName: "BASH", success: true, result: { stdout: "ls output" } },
			{ attemptId: "a3", stepNumber: 5, timestamp: 50, actionName: "REPLY", success: true, result: { text: "final reply" } },
		];
		expect(extractReply(d)).toBe("final reply");
	});

	test("extractReply falls back to last response-step LLM call", () => {
		const d = baseDetail();
		d.actions = [];
		d.llmCalls = [
			{ callId: "c1", stepNumber: 1, timestamp: 10, model: "opus", stepType: "should_respond", response: "yes" },
			{ callId: "c2", stepNumber: 3, timestamp: 30, model: "opus", stepType: "response", response: "this is my reply" },
		];
		expect(extractReply(d)).toBe("this is my reply");
	});

	test("extractReply returns null when no reply text anywhere", () => {
		expect(extractReply(baseDetail())).toBeNull();
	});

	test("extractReply pulls text: from ACTION_PLANNER TOON output with quoted code-text block", () => {
		const d = baseDetail();
		d.llmCalls = [
			{
				callId: "c1",
				stepNumber: 1,
				timestamp: 10,
				model: "ACTION_PLANNER",
				purpose: "response",
				response: [
					"thought: User is setting a goal",
					"actions[1]: SET_GOAL",
					"providers: ",
					"",
					"text: \"code_text_start\": \"abc123\"",
					"Goal locked: ship the prompt template editor by EOD Friday.",
					"",
					"Ready to move. What's first?",
					"\"code_text_end\": \"abc123\"",
					"simple: false",
				].join("\n"),
			},
		];
		const reply = extractReply(d);
		expect(reply).toContain("Goal locked");
		expect(reply).toContain("Ready to move");
		expect(reply).not.toContain("thought:");
		expect(reply).not.toContain("code_text_start");
	});

	test("extractReply pulls text: from ACTION_PLANNER TOON output with bare code-text block (no quotes)", () => {
		const d = baseDetail();
		d.llmCalls = [
			{
				callId: "c1",
				stepNumber: 1,
				timestamp: 10,
				model: "ACTION_PLANNER",
				purpose: "response",
				response: [
					"thought: yo",
					"actions[1]: TASK_HISTORY",
					"text: code_text_start: 04a2dc07",
					"Checking live state...",
					"code_text_end: 04a2dc07",
					"simple: false",
				].join("\n"),
			},
		];
		const reply = extractReply(d);
		expect(reply).toBe("Checking live state...");
	});

	test("extractReply prefers post-action summary call over planner's interim text", () => {
		const d = baseDetail();
		d.llmCalls = [
			{
				callId: "c1",
				stepNumber: 1,
				timestamp: 10,
				model: "ACTION_PLANNER",
				purpose: "response",
				response: "text: code_text_start: x\nChecking live state...\ncode_text_end: x",
			},
			{
				callId: "c2",
				stepNumber: 2,
				timestamp: 20,
				model: "TEXT_SMALL",
				purpose: "response",
				response: "Goal: ship the prompt template editor by EOD Friday. Current state unknown.",
			},
		];
		const reply = extractReply(d);
		expect(reply).toBe("Goal: ship the prompt template editor by EOD Friday. Current state unknown.");
	});

	test("extractReply skips short TOON config snippets like 'providers: foo'", () => {
		const d = baseDetail();
		d.llmCalls = [
			{
				callId: "c1",
				stepNumber: 1,
				timestamp: 10,
				model: "ACTION_PLANNER",
				purpose: "response",
				response: 'text: "the real reply"',
			},
			{
				callId: "c2",
				stepNumber: 2,
				timestamp: 20,
				model: "TEXT_LARGE",
				purpose: "response",
				response: "providers:",
			},
		];
		expect(extractReply(d)).toBe("the real reply");
	});

	test("extractReply handles single-line TOON text field", () => {
		const d = baseDetail();
		d.llmCalls = [
			{
				callId: "c1",
				stepNumber: 1,
				timestamp: 10,
				model: "ACTION_PLANNER",
				purpose: "response",
				response: 'thought: think\nactions[1]: REPLY\ntext: "just a one-liner reply"\nsimple: true',
			},
		];
		expect(extractReply(d)).toBe("just a one-liner reply");
	});

	test("extractReply prefers REPLY action result over planner text when both present", () => {
		const d = baseDetail();
		d.actions = [
			{ attemptId: "a1", stepNumber: 1, timestamp: 10, actionName: "REPLY", success: true, result: { text: "from-action" } },
		];
		d.llmCalls = [
			{ callId: "c1", stepNumber: 1, timestamp: 5, model: "ACTION_PLANNER", purpose: "response", response: 'text: "from-planner"' },
		];
		expect(extractReply(d)).toBe("from-action");
	});

	test("extractThinking dedupes across steps + llmCalls", () => {
		const d = baseDetail();
		d.steps = [
			{ stepNumber: 1, timestamp: 10, llmCallCount: 1, providerAccessCount: 0, hasAction: false, reasoning: "Step 1 reasoning" },
			{ stepNumber: 2, timestamp: 20, llmCallCount: 1, providerAccessCount: 0, hasAction: true, actionName: "REPLY", reasoning: "Step 2 reasoning" },
		];
		d.llmCalls = [
			{ callId: "c1", stepNumber: 1, timestamp: 11, model: "opus", reasoning: "Step 1 reasoning" },
			{ callId: "c2", stepNumber: 3, timestamp: 30, model: "opus", reasoning: "Distinct thought" },
		];
		const out = extractThinking(d);
		expect(out.map((t) => t.text)).toEqual(["Step 1 reasoning", "Step 2 reasoning", "Distinct thought"]);
	});

	test("extractActionsTaken surfaces name + success + preview", () => {
		const d = baseDetail();
		d.actions = [
			{ attemptId: "a1", stepNumber: 1, timestamp: 10, actionName: "BASH", success: true, result: { text: "command output goes here" } },
			{ attemptId: "a2", stepNumber: 2, timestamp: 20, actionName: "REPLY", success: false, error: "no model" },
		];
		const out = extractActionsTaken(d);
		expect(out).toHaveLength(2);
		expect(out[0]?.name).toBe("BASH");
		expect(out[0]?.success).toBe(true);
		expect(out[0]?.resultPreview).toBe("command output goes here");
		expect(out[1]?.name).toBe("REPLY");
		expect(out[1]?.success).toBe(false);
	});

	test("extractPrompts orders by step + filters out promptless calls", () => {
		const d = baseDetail();
		d.llmCalls = [
			{ callId: "c2", stepNumber: 2, timestamp: 20, model: "opus", systemPrompt: "sys2", userPrompt: "u2" },
			{ callId: "c1", stepNumber: 1, timestamp: 10, model: "opus", systemPrompt: "sys1", userPrompt: "u1" },
			{ callId: "c3", stepNumber: 3, timestamp: 30, model: "opus" /* no prompts → filtered */ },
		];
		const out = extractPrompts(d);
		expect(out).toHaveLength(2);
		expect(out[0]?.callId).toBe("c1");
		expect(out[1]?.callId).toBe("c2");
	});

	test("extractSimpleView wires everything together", () => {
		const d = baseDetail();
		d.raw = { rootMessage: { text: "build a thing" } };
		d.actions = [
			{ attemptId: "a1", stepNumber: 2, timestamp: 20, actionName: "REPLY", success: true, result: { text: "thing built" } },
		];
		d.steps = [
			{ stepNumber: 1, timestamp: 10, llmCallCount: 1, providerAccessCount: 0, hasAction: false, reasoning: "thought about it" },
		];
		const view = extractSimpleView(d);
		expect(view.request).toBe("build a thing");
		expect(view.reply).toBe("thing built");
		expect(view.thinking).toHaveLength(1);
		expect(view.actionsTaken).toHaveLength(1);
		expect(view.actionsTaken[0]?.name).toBe("REPLY");
	});
});
