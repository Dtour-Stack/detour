/**
 * Pure-function tests for the companion job prompt templates. We verify
 * that:
 *   - each prompt has the LAST-LINE-IS-CUE shape base models like
 *   - parse helpers tolerate model drift (extra whitespace, prose
 *     before the answer, capitalization)
 *   - prompts respect the input-length cap (no unbounded blowup if a
 *     user pastes a 50K-char message)
 */
import { describe, expect, test } from "bun:test";
import {
	compressPrompt,
	memoryQueryPrompt,
	parseMemoryQueryOutput,
	parseShouldRespondOutput,
	parseTriageOutput,
	personaPrePassPrompt,
	shouldRespondPrompt,
	triagePrompt,
} from "./companion-jobs";

describe("triage", () => {
	test("prompt ends with 'Label:' so a base model continues with a single token", () => {
		const { input } = triagePrompt("hey");
		expect(input.trimEnd().endsWith("Label:")).toBe(true);
	});

	test("respects 600-char input cap (long pastes don't blow up the prompt)", () => {
		const huge = "a".repeat(50_000);
		const { input } = triagePrompt(huge);
		// Last "Message: " line should carry at most 600 chars
		const idx = input.lastIndexOf("Message: ");
		const msgLine = input.slice(idx + "Message: ".length).split("\n")[0]!;
		expect(msgLine.length).toBeLessThanOrEqual(600);
	});

	test("parseTriageOutput recognizes each canonical label", () => {
		expect(parseTriageOutput("chat")).toBe("chat");
		expect(parseTriageOutput(" tool ")).toBe("tool");
		expect(parseTriageOutput("Search\nMessage: …")).toBe("search");
		expect(parseTriageOutput("complex")).toBe("complex");
		expect(parseTriageOutput("skip")).toBe("skip");
		expect(parseTriageOutput("ignore this")).toBe("skip");
	});

	test("parseTriageOutput falls back to 'complex' on unrecognized output", () => {
		// "complex" = safe default; keeps the planner in the loop
		expect(parseTriageOutput("")).toBe("complex");
		expect(parseTriageOutput("wat")).toBe("complex");
		expect(parseTriageOutput("???")).toBe("complex");
	});
});

describe("shouldRespond", () => {
	test("prompt ends with 'Answer:' cue", () => {
		const { input } = shouldRespondPrompt("Detour", "#general", [
			{ author: "alice", text: "hey detour any updates?" },
		]);
		expect(input.trimEnd().endsWith("Answer:")).toBe(true);
	});

	test("includes the agent identity in the prompt", () => {
		const { input } = shouldRespondPrompt("Detour Squirrel", "#dev", [
			{ author: "shaw", text: "lol" },
		]);
		expect(input).toContain("Detour Squirrel");
	});

	test("caps message history at the 12 most recent entries", () => {
		const msgs = Array.from({ length: 50 }, (_, i) => ({
			author: `u${i}`,
			text: `msg-${i}`,
		}));
		const { input } = shouldRespondPrompt("Detour", "#room", msgs);
		// Should contain the last few, not the first
		expect(input).toContain("msg-49");
		expect(input).toContain("msg-48");
		expect(input).not.toContain("msg-0\n");
	});

	test("parseShouldRespondOutput maps yes/y/true to true and everything else to false", () => {
		expect(parseShouldRespondOutput("yes")).toBe(true);
		expect(parseShouldRespondOutput("YES")).toBe(true);
		expect(parseShouldRespondOutput(" y ")).toBe(true);
		expect(parseShouldRespondOutput("true")).toBe(true);
		expect(parseShouldRespondOutput("no")).toBe(false);
		expect(parseShouldRespondOutput("nope")).toBe(false);
		expect(parseShouldRespondOutput("")).toBe(false);
		expect(parseShouldRespondOutput("maybe")).toBe(false);
	});
});

describe("memoryQuery", () => {
	test("parseMemoryQueryOutput strips bullets and caps at 3 queries", () => {
		const text = `- topic A
- topic B
- topic C
- topic D extra
- topic E`;
		const queries = parseMemoryQueryOutput(text);
		expect(queries.length).toBe(3);
		expect(queries[0]).toBe("topic A");
		expect(queries[2]).toBe("topic C");
	});

	test("drops empty + over-long lines", () => {
		const text = ["", "  ", "valid query", "x".repeat(500)].join("\n");
		const queries = parseMemoryQueryOutput(text);
		expect(queries).toEqual(["valid query"]);
	});

	test("handles mixed bullet styles (*, -, no bullet)", () => {
		const text = `* first
- second
third`;
		expect(parseMemoryQueryOutput(text)).toEqual(["first", "second", "third"]);
	});
});

describe("compress", () => {
	test("includes target token budget in the prompt", () => {
		const { input } = compressPrompt("user said hi", 150);
		expect(input).toContain("150 tokens");
	});

	test("caps input history at 6KB (long sessions don't blow context)", () => {
		const huge = "x".repeat(20_000);
		const { input } = compressPrompt(huge, 200);
		// 6KB cap + the framing text — input shouldn't be much bigger than ~6.5KB
		expect(input.length).toBeLessThan(7000);
	});

	test("ends with 'Summary:' cue", () => {
		const { input } = compressPrompt("hello", 100);
		expect(input.trimEnd().endsWith("Summary:")).toBe(true);
	});
});

describe("personaPrePass", () => {
	test("includes agent name + ends with 'Frame:' cue", () => {
		const { input } = personaPrePassPrompt("Detour Squirrel", "what time is it");
		expect(input).toContain("Detour Squirrel");
		expect(input.trimEnd().endsWith("Frame:")).toBe(true);
	});

	test("budgets ≤60 max output tokens (one short sentence)", () => {
		const { maxTokens } = personaPrePassPrompt("Detour", "hi");
		expect(maxTokens).toBeLessThanOrEqual(60);
	});
});
