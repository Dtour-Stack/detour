import { describe, expect, test } from "bun:test";
import type { IAgentRuntime } from "@elizaos/core";
import {
	DETOUR_CONTINUOUS_IMPROVEMENT_DEFAULT,
	DETOUR_CONTINUOUS_IMPROVEMENT_TEMPLATE,
	DETOUR_DPE_FALLBACK_DEFAULT,
	DETOUR_DPE_FALLBACK_TEMPLATE,
	DETOUR_DREAM_CONSOLIDATION_DEFAULT,
	DETOUR_DREAM_CONSOLIDATION_TEMPLATE,
	DETOUR_GOAL_EXTRACTION_DEFAULT,
	DETOUR_GOAL_EXTRACTION_TEMPLATE,
	getPromptSlot,
	PROMPT_SLOTS,
	renderPromptTemplate,
} from "./prompt-templates";

function makeRuntime(templates?: Record<string, string>): IAgentRuntime {
	return {
		character: {
			name: "Test Squirrel",
			...(templates && { templates }),
		},
	} as unknown as IAgentRuntime;
}

describe("renderPromptTemplate", () => {
	test("substitutes variables in default body when no override is set", () => {
		const runtime = makeRuntime();
		const out = renderPromptTemplate(
			runtime,
			"missing-slot",
			{ name: "Detour", noun: "squirrel" },
			"Hello {{name}} the {{noun}}.",
		);
		expect(out).toBe("Hello Detour the squirrel.");
	});

	test("uses the runtime override body when present", () => {
		const runtime = makeRuntime({ mySlot: "Override hello {{name}}." });
		const out = renderPromptTemplate(
			runtime,
			"mySlot",
			{ name: "Dex" },
			"Default hello {{name}}.",
		);
		expect(out).toBe("Override hello Dex.");
	});

	test("leaves unknown variables as-is for easy debugging", () => {
		const runtime = makeRuntime();
		const out = renderPromptTemplate(
			runtime,
			"slot",
			{ have: "yes" },
			"present={{have}} missing={{nope}}",
		);
		expect(out).toBe("present=yes missing={{nope}}");
	});

	test("empty-string override falls back to default", () => {
		const runtime = makeRuntime({ slot: "" });
		const out = renderPromptTemplate(runtime, "slot", {}, "default body");
		expect(out).toBe("default body");
	});

	test("goal extraction default substitutes {{userMessage}}", () => {
		const runtime = makeRuntime();
		const out = renderPromptTemplate(
			runtime,
			DETOUR_GOAL_EXTRACTION_TEMPLATE,
			{ userMessage: "build me a Solana token dashboard" },
			DETOUR_GOAL_EXTRACTION_DEFAULT,
		);
		expect(out).toContain("build me a Solana token dashboard");
		expect(out).toContain("Extract the user's single primary objective");
	});

	test("dream consolidation default substitutes all three variables", () => {
		const runtime = makeRuntime();
		const out = renderPromptTemplate(
			runtime,
			DETOUR_DREAM_CONSOLIDATION_TEMPLATE,
			{
				instructions: "INST",
				memoriesBlock: "MEM",
				trajectoriesBlock: "TRJ",
			},
			DETOUR_DREAM_CONSOLIDATION_DEFAULT,
		);
		expect(out).toContain("INST");
		expect(out).toContain("MEM");
		expect(out).toContain("TRJ");
		expect(out).not.toContain("{{instructions}}");
		expect(out).not.toContain("{{memoriesBlock}}");
		expect(out).not.toContain("{{trajectoriesBlock}}");
	});

	test("dpe fallback default substitutes all four variables", () => {
		const runtime = makeRuntime();
		const out = renderPromptTemplate(
			runtime,
			DETOUR_DPE_FALLBACK_TEMPLATE,
			{
				agentName: "AGT",
				characterContext: "CTX",
				memoryContext: "MEM",
				conversation: "CONV",
			},
			DETOUR_DPE_FALLBACK_DEFAULT,
		);
		expect(out).toContain("You are AGT");
		expect(out).toContain("CTX");
		expect(out).toContain("MEM");
		expect(out).toContain("CONV");
	});

	test("continuous improvement default substitutes logs + memories", () => {
		const runtime = makeRuntime();
		const out = renderPromptTemplate(
			runtime,
			DETOUR_CONTINUOUS_IMPROVEMENT_TEMPLATE,
			{ logs: "LOGS_BLOCK", memories: "MEM_BLOCK" },
			DETOUR_CONTINUOUS_IMPROVEMENT_DEFAULT,
		);
		expect(out).toContain("LOGS_BLOCK");
		expect(out).toContain("MEM_BLOCK");
	});

	test("override fully replaces default body — defaults are not concatenated", () => {
		const runtime = makeRuntime({
			[DETOUR_GOAL_EXTRACTION_TEMPLATE]: "Custom goal extractor: read {{userMessage}}",
		});
		const out = renderPromptTemplate(
			runtime,
			DETOUR_GOAL_EXTRACTION_TEMPLATE,
			{ userMessage: "test" },
			DETOUR_GOAL_EXTRACTION_DEFAULT,
		);
		expect(out).toBe("Custom goal extractor: read test");
		expect(out).not.toContain("Extract the user's single primary objective");
	});
});

describe("PROMPT_SLOTS registry", () => {
	test("includes all four Detour-owned slots with default bodies", () => {
		const detour = PROMPT_SLOTS.filter((s) => s.kind === "detour-owned");
		expect(detour.length).toBe(4);
		for (const slot of detour) {
			expect(slot.defaultBody).not.toBeNull();
			expect((slot.defaultBody as string).length).toBeGreaterThan(50);
		}
	});

	test("slot names are unique", () => {
		const names = PROMPT_SLOTS.map((s) => s.name);
		expect(new Set(names).size).toBe(names.length);
	});

	test("getPromptSlot returns spec by name", () => {
		const spec = getPromptSlot(DETOUR_DREAM_CONSOLIDATION_TEMPLATE);
		expect(spec).not.toBeNull();
		expect(spec?.kind).toBe("detour-owned");
		expect(spec?.variables).toContain("memoriesBlock");
	});

	test("getPromptSlot returns null for unknown name", () => {
		expect(getPromptSlot("not-a-real-slot")).toBeNull();
	});

	test("eliza-builtin slots have null defaultBody", () => {
		const builtins = PROMPT_SLOTS.filter((s) => s.kind === "eliza-builtin");
		expect(builtins.length).toBeGreaterThanOrEqual(6);
		for (const slot of builtins) {
			expect(slot.defaultBody).toBeNull();
		}
	});
});
