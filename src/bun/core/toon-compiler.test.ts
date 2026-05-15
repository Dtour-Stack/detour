import { describe, expect, test } from "bun:test";
import { compileToToon } from "./toon-compiler";

const PLANNER_OBJECT = {
	thought: "User wants a research task; spawn a sub-agent.",
	actions: ["CREATE_TASK"],
	providers: "",
	text: "I'll spin up a research agent.",
	simple: false,
} as const;

describe("compileToToon", () => {
	test("returns empty input unchanged", () => {
		const r = compileToToon("");
		expect(r.source).toBe("raw");
		expect(r.rewritten).toBe(false);
	});

	test("already-canonical TOON round-trips cleanly", () => {
		const toon = [
			"thought: hi",
			"actions[1]: REPLY",
			"providers: ",
			"text: Hello there",
			"simple: true",
		].join("\n");
		const r = compileToToon(toon);
		expect(r.source).toBe("toon");
		// Output is still parseable TOON.
		expect(r.text).toMatch(/^thought:/m);
		expect(r.text).toContain("text: Hello there");
	});

	test("JSON → canonical TOON", () => {
		const r = compileToToon(JSON.stringify(PLANNER_OBJECT, null, 2));
		expect(r.source).toBe("json");
		expect(r.rewritten).toBe(true);
		expect(r.text).toMatch(/thought:/);
		expect(r.text).toContain("User wants a research task");
		expect(r.text).toContain("CREATE_TASK");
	});

	test("JSON5 (trailing commas, unquoted keys) → canonical TOON", () => {
		const json5Input = `{
			thought: "ok",
			actions: ["REPLY",],
			providers: "",
			text: "hi",
			simple: true,
		}`;
		const r = compileToToon(json5Input);
		expect(r.source).toBe("json");
		expect(r.text).toContain("REPLY");
	});

	test("JSON wrapped in conversational prose extracts the object", () => {
		const input = `Sure, here is the response:\n${JSON.stringify(PLANNER_OBJECT)}\nLet me know if you need anything else.`;
		const r = compileToToon(input);
		expect(r.source).toBe("json");
		expect(r.text).toContain("CREATE_TASK");
	});

	test("JSON inside markdown fence → canonical TOON", () => {
		const input = "```json\n" + JSON.stringify(PLANNER_OBJECT) + "\n```";
		const r = compileToToon(input);
		expect(r.source).toBe("json");
		expect(r.rewritten).toBe(true);
	});

	test("YAML → canonical TOON", () => {
		const yamlInput = [
			"thought: hello",
			"actions:",
			"  - REPLY",
			"providers: ''",
			"text: hi there",
			"simple: true",
		].join("\n");
		const r = compileToToon(yamlInput);
		// YAML's `thought: hello` shape happens to match TOON syntax;
		// the compiler may detect it as TOON OR YAML depending on the
		// strict decoder. Either way it must produce valid output.
		expect(["yaml", "toon"]).toContain(r.source);
		expect(r.text).toContain("hello");
		expect(r.text).toContain("REPLY");
	});

	test("Loose key:value prose → canonical TOON", () => {
		// What you might see when a confused model gives up on
		// structure and writes the fields in natural order.
		const input = [
			"Here's my plan:",
			"thought: I'll reply briefly.",
			"actions: [REPLY]",
			"providers: ",
			"text: Hi there!",
			"simple: true",
			"Hope that works.",
		].join("\n");
		const r = compileToToon(input);
		// Either loose-keys or toon, depending on heuristic order — either works.
		expect(r.text).toContain("Hi there");
		expect(r.text).toMatch(/thought:|text:/);
	});

	test("strips outer markdown fence + <think> block before parsing", () => {
		const input = [
			"<think>",
			"Let me think...",
			"</think>",
			"```toon",
			"thought: ok",
			"actions[1]: REPLY",
			"text: hi",
			"simple: true",
			"```",
		].join("\n");
		const r = compileToToon(input);
		expect(r.text).not.toContain("<think>");
		expect(r.text).not.toContain("```");
		expect(r.text).toContain("thought:");
	});

	test("totally non-structured prose passes through unchanged-ish", () => {
		const input = "Hello there, this is just regular chat with no fields.";
		const r = compileToToon(input);
		expect(r.source).toBe("raw");
	});

	test("output is always non-empty when input has content", () => {
		const inputs = [
			JSON.stringify(PLANNER_OBJECT),
			"thought: x\nactions[1]: REPLY\ntext: y\nsimple: true",
			"Just prose here, nothing structured.",
		];
		for (const input of inputs) {
			const r = compileToToon(input);
			expect(r.text.length).toBeGreaterThan(0);
		}
	});

	test("handles JSON with nested objects (action params)", () => {
		const input = JSON.stringify({
			thought: "spawn research",
			actions: [{ name: "CREATE_TASK", params: { kind: "research", goal: "find papers" } }],
			text: "spawning",
			simple: false,
		});
		const r = compileToToon(input);
		expect(r.source).toBe("json");
		expect(r.text).toContain("CREATE_TASK");
		expect(r.text).toContain("research");
	});

	test("handles JSON arrays at top level (some model variants)", () => {
		const input = JSON.stringify([{ thought: "x", text: "y" }]);
		const r = compileToToon(input);
		expect(r.source).toBe("json");
		expect(r.text.length).toBeGreaterThan(0);
	});

	test("invalid JSON inside fence → falls through to loose-keys or raw", () => {
		const input = "```json\n{thought: missing quote, actions: [REPLY}\n```";
		const r = compileToToon(input);
		// Either loose-keys catches the `thought:` line or it passes
		// through as raw — either way doesn't crash.
		expect(r.text.length).toBeGreaterThan(0);
	});
});
