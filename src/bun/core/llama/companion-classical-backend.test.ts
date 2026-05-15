/**
 * Classical backend primitive tests. These document the heuristic
 * choices so regressions stand out — the goal isn't "agree with the
 * LLM," it's "be right on the obvious cases and decline politely on
 * the rest so the LLM (or default fallthrough) gets a chance."
 */
import { describe, expect, test } from "bun:test";
import {
	CompanionClassicalBackend,
	classicalCompanionPrimitives,
} from "./companion-classical-backend";

const { classifyTriage, decideShouldRespond, compressExtractive, isAck } =
	classicalCompanionPrimitives;

describe("classifyTriage", () => {
	test("acks → skip", () => {
		expect(classifyTriage("ok")).toBe("skip");
		expect(classifyTriage("lol")).toBe("skip");
		expect(classifyTriage("haha")).toBe("skip");
		expect(classifyTriage("thx")).toBe("skip");
	});
	test("URLs → search", () => {
		expect(classifyTriage("see https://example.com/post")).toBe("search");
	});
	test("lookup verbs → search", () => {
		expect(classifyTriage("look up the SOL price")).toBe("search");
		expect(classifyTriage("what is mev")).toBe("search");
	});
	test("action verbs → tool", () => {
		expect(classifyTriage("deploy the worker")).toBe("tool");
		expect(classifyTriage("post a tweet about the launch")).toBe("tool");
	});
	test("long multi-clause → complex", () => {
		expect(
			classifyTriage(
				"deploy the worker and then run the tests and also send the report and then update the readme",
			),
		).toBe("complex");
	});
	test("default → chat", () => {
		expect(classifyTriage("what do you think about that")).toBe("chat");
	});
});

describe("decideShouldRespond", () => {
	test("agent was the last speaker → false (don't double-speak)", () => {
		const out = decideShouldRespond("Detour", [
			{ author: "alice", text: "any updates?" },
			{ author: "Detour", text: "shipped" },
		]);
		expect(out).toBe(false);
	});
	test("direct @-mention of agent → true", () => {
		const out = decideShouldRespond("Detour", [
			{ author: "alice", text: "@detour how's it going?" },
		]);
		expect(out).toBe(true);
	});
	test("agent name without @ also fires", () => {
		const out = decideShouldRespond("Detour", [
			{ author: "alice", text: "hey detour what about that?" },
		]);
		expect(out).toBe(true);
	});
	test("short ack → false", () => {
		expect(
			decideShouldRespond("Detour", [{ author: "alice", text: "lol" }]),
		).toBe(false);
	});
	test("ambiguous question → null (let LLM weigh in)", () => {
		expect(
			decideShouldRespond("Detour", [
				{ author: "alice", text: "is anyone here?" },
			]),
		).toBeNull();
	});
});

describe("compressExtractive", () => {
	test("short input passes through", () => {
		const out = compressExtractive("hi", 100);
		expect(out).toBe("hi");
	});
	test("long history is reduced", () => {
		const history = Array.from({ length: 30 }, (_, i) =>
			`Sentence number ${i} containing distinct content about deploys.`,
		).join(" ");
		const out = compressExtractive(history, 40);
		expect(out.length).toBeLessThan(history.length);
		// First and last sentence should survive thanks to position bonus.
		expect(out).toContain("Sentence number 0");
	});
});

describe("isAck", () => {
	test("recognizes common acks", () => {
		expect(isAck("ok")).toBe(true);
		expect(isAck("nice")).toBe(true);
		expect(isAck("👍")).toBe(true);
		expect(isAck("")).toBe(true);
	});
	test("does not flag substantive text", () => {
		expect(isAck("can you deploy this?")).toBe(false);
	});
});

describe("CompanionClassicalBackend", () => {
	test("availability is always true", () => {
		const b = new CompanionClassicalBackend();
		expect(b.availability().available).toBe(true);
	});
	test("personaPrePass returns null (generation isn't its job)", async () => {
		const b = new CompanionClassicalBackend();
		expect(await b.personaPrePass()).toBeNull();
	});
});
