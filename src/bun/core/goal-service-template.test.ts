import { describe, expect, test } from "bun:test";
import type { IAgentRuntime } from "@elizaos/core";
import { GoalService } from "./goal-service";
import { DETOUR_GOAL_EXTRACTION_TEMPLATE } from "./prompt-templates";

interface FakeMemory {
	id: string;
	text: string;
	tags: string[];
	type: string;
	path: string;
	roomId: string;
	metadata: Record<string, unknown>;
}

function makeFakeMemoryService() {
	const store = new Map<string, FakeMemory>();
	let nextId = 1;
	return {
		store,
		service: {
			async create(input: { text: string; roomId?: string; tags?: string[]; type?: string; extraMetadata?: Record<string, unknown> }) {
				const id = `m-${nextId++}`;
				store.set(id, {
					id,
					text: input.text,
					tags: input.tags ?? [],
					type: input.type ?? "custom",
					path: "/goals/test",
					roomId: input.roomId ?? "",
					metadata: { ...(input.extraMetadata ?? {}) },
				});
				return { id };
			},
			async list() { return []; },
			async get() { return null; },
			async update() { return true; },
			async remove() { return true; },
			async search() { return []; },
		} as never,
	};
}

describe("goal-service prompt template integration", () => {
	test("uses default goal extraction prompt when no override registered", async () => {
		const { service: memoryService } = makeFakeMemoryService();
		let promptSeen = "";
		const runtime = {
			character: { name: "Test" },
			useModel: async (_t: unknown, params: { prompt: string }) => {
				promptSeen = params.prompt;
				return "Build the test thing";
			},
		} as unknown as IAgentRuntime;
		const goal = new GoalService(() => runtime, memoryService);
		await goal.ensureGoalForTurn("room-x", "please build me the test thing right now");
		expect(promptSeen).toContain("Extract the user's single primary objective");
		expect(promptSeen).toContain("please build me the test thing right now");
	});

	test("uses pensieve override when character.templates contains the slot", async () => {
		const { service: memoryService } = makeFakeMemoryService();
		let promptSeen = "";
		const runtime = {
			character: {
				name: "Test",
				templates: {
					[DETOUR_GOAL_EXTRACTION_TEMPLATE]: "OVERRIDE: extract from --> {{userMessage}}",
				},
			},
			useModel: async (_t: unknown, params: { prompt: string }) => {
				promptSeen = params.prompt;
				return "the extracted goal";
			},
		} as unknown as IAgentRuntime;
		const goal = new GoalService(() => runtime, memoryService);
		await goal.ensureGoalForTurn("room-y", "please build me a different thing right now");
		expect(promptSeen).toContain("OVERRIDE: extract from -->");
		expect(promptSeen).toContain("please build me a different thing");
		expect(promptSeen).not.toContain("Extract the user's single primary objective");
	});
});
