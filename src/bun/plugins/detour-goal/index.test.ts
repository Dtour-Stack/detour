import { describe, expect, test } from "bun:test";
import type { Action, IAgentRuntime, Memory, Plugin } from "@elizaos/core";
import { GoalService } from "../../core/goal-service";
import {
	attachGoalService,
	detourGoalPlugin,
} from "./index";

function makeFakeMemoryService(): {
	store: Map<string, { text: string; tags: string[]; metadata: Record<string, unknown>; roomId: string }>;
	service: {
		create: (input: {
			text: string;
			roomId?: string;
			tags?: string[];
			extraMetadata?: Record<string, unknown>;
		}) => Promise<{ id: string } | null>;
		list: (opts: { tag?: string; type?: string }) => Promise<Array<{ id: string; roomId?: string; preview: string; tags?: string[]; createdAt?: number; path: string; tableName: string }>>;
		get: (id: string) => Promise<{ id: string; content: { text: string }; metadata: Record<string, unknown>; tags?: string[]; path: string; tableName: string; preview: string; hasEmbedding: boolean } | null>;
		update: () => Promise<boolean>;
		remove: () => Promise<boolean>;
	};
} {
	const store = new Map<string, { text: string; tags: string[]; metadata: Record<string, unknown>; roomId: string }>();
	let nextId = 1;
	return {
		store,
		service: {
			create: async ({ text, roomId, tags, extraMetadata }) => {
				const id = `mem-${nextId++}`;
				store.set(id, {
					text,
					tags: tags ?? [],
					metadata: extraMetadata ?? {},
					roomId: roomId ?? "",
				});
				return { id };
			},
			list: async (opts) => {
				const out: Array<{ id: string; roomId?: string; preview: string; tags?: string[]; createdAt?: number; path: string; tableName: string }> = [];
				for (const [id, row] of store) {
					if (opts.tag && !row.tags.includes(opts.tag)) continue;
					out.push({
						id,
						roomId: row.roomId,
						preview: row.text,
						tags: row.tags,
						createdAt: Date.now(),
						path: "/goals/test",
						tableName: "memories",
					});
				}
				return out;
			},
			get: async (id: string) => {
				const row = store.get(id);
				if (!row) return null;
				return {
					id,
					content: { text: row.text },
					metadata: row.metadata,
					tags: row.tags,
					path: "/goals/test",
					tableName: "memories",
					preview: row.text,
					hasEmbedding: false,
				};
			},
			update: async () => true,
			remove: async () => true,
		},
	};
}

describe("detour-goal plugin", () => {
	test("provider returns empty-state text when no goal is set", async () => {
		const { service: memoryService } = makeFakeMemoryService();
		const goal = new GoalService(() => null, memoryService as never);
		attachGoalService(goal);
		const provider = (detourGoalPlugin.providers ?? [])[0];
		expect(provider?.name).toBe("DETOUR_ACTIVE_GOAL");
		const result = await provider!.get({} as IAgentRuntime, { roomId: "room-1" } as Memory, {} as never);
		expect(typeof result.text).toBe("string");
		expect(result.text).toContain("none set yet");
		expect(result.values?.goalActive).toBe(false);
	});

	test("provider surfaces the active goal once set", async () => {
		const { service: memoryService } = makeFakeMemoryService();
		const goal = new GoalService(() => null, memoryService as never);
		attachGoalService(goal);
		await goal.setActiveGoal({
			roomId: "room-1",
			text: "Ship the budget app demo",
			source: "user-explicit",
		});
		const provider = (detourGoalPlugin.providers ?? [])[0];
		const result = await provider!.get({} as IAgentRuntime, { roomId: "room-1" } as Memory, {} as never);
		expect(result.text).toContain("Ship the budget app demo");
		expect(result.text).toContain("ACTIVE GOAL");
		expect(result.values?.goalActive).toBe(true);
	});

	test("wrapping a spawn action injects the goal into memoryContent", async () => {
		const { service: memoryService } = makeFakeMemoryService();
		const goal = new GoalService(() => null, memoryService as never);
		attachGoalService(goal);
		await goal.setActiveGoal({
			roomId: "room-1",
			text: "Get auth working end-to-end",
			source: "user-explicit",
		});

		// Fake spawn action — captures the memoryContent it received.
		const captured: { memoryContent?: unknown } = {};
		const fakeSpawnAction: Action = {
			name: "CREATE_TASK",
			description: "fake spawn",
			validate: async () => true,
			examples: [],
			handler: async (_rt, message) => {
				const content = message.content as { memoryContent?: unknown };
				captured.memoryContent = content.memoryContent;
				return { success: true };
			},
		};

		// Fake runtime carrying just `actions`
		const runtime = {
			actions: [fakeSpawnAction],
			useModel: async () => "Get auth working end-to-end",
		} as unknown as IAgentRuntime;

		// Run plugin init to wrap actions on the runtime
		await detourGoalPlugin.init?.({} as never, runtime);
		// init schedules deferred wrap passes via setTimeout — give them a tick
		await new Promise((resolve) => setTimeout(resolve, 50));

		await fakeSpawnAction.handler(
			runtime,
			{
				roomId: "room-1",
				content: { memoryContent: "original brief here" },
			} as never,
			undefined,
			undefined,
		);

		expect(typeof captured.memoryContent).toBe("string");
		expect(String(captured.memoryContent)).toContain("Get auth working end-to-end");
		expect(String(captured.memoryContent)).toContain("original brief here");
		expect(String(captured.memoryContent)).toContain("Goal id:");
	});

	test("ensureGoalForTurn skips chitchat", async () => {
		const { service: memoryService } = makeFakeMemoryService();
		let modelCalls = 0;
		const fakeRuntime = {
			useModel: async () => {
				modelCalls++;
				return "Some derived goal";
			},
		} as unknown as IAgentRuntime;
		const goal = new GoalService(() => fakeRuntime, memoryService as never);
		const result = await goal.ensureGoalForTurn("room-1", "hi");
		expect(result).toBeNull();
		expect(modelCalls).toBe(0);
	});

	test("ensureGoalForTurn extracts on substantive turn", async () => {
		const { service: memoryService } = makeFakeMemoryService();
		const fakeRuntime = {
			useModel: async () => "Build a Solana token launch dashboard",
		} as unknown as IAgentRuntime;
		const goal = new GoalService(() => fakeRuntime, memoryService as never);
		const result = await goal.ensureGoalForTurn(
			"room-2",
			"can you build me a Solana token launch dashboard with live charts and a buy widget",
		);
		expect(result).not.toBeNull();
		expect(result?.text).toContain("Solana");
		expect(result?.source).toBe("user-implicit");
	});
});

// Silence the unused-variable check on the Plugin type import (the type is
// used implicitly via detourGoalPlugin).
void (null as unknown as Plugin);
