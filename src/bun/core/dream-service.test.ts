import { describe, expect, test } from "bun:test";
import { DreamService } from "./dream-service";
import type { PensieveMemoryService, PensieveMemorySummary } from "./pensieve/memory-service";
import type { ActivityTrajectoryService } from "./activity/trajectory-service";
import type { RuntimeService } from "./runtime";

interface FakeMemory {
	id: string;
	text: string;
	tags: string[];
	type: string;
	path: string;
	roomId: string;
	metadata: Record<string, unknown>;
}

function makeFakeMemoryService(): {
	store: Map<string, FakeMemory>;
	service: PensieveMemoryService;
} {
	const store = new Map<string, FakeMemory>();
	let nextId = 1;
	const svc = {
		async create(input: {
			text: string;
			path?: string;
			type?: string;
			tags?: string[];
			roomId?: string;
			extraMetadata?: Record<string, unknown>;
		}) {
			const id = `m-${nextId++}`;
			store.set(id, {
				id,
				text: input.text,
				tags: input.tags ?? [],
				type: input.type ?? "custom",
				path: input.path ?? "/uncategorized",
				roomId: input.roomId ?? "",
				metadata: { ...(input.extraMetadata ?? {}) },
			});
			return { id };
		},
		async list(opts: { type?: string; tag?: string; pathPrefix?: string; limit?: number }): Promise<PensieveMemorySummary[]> {
			const out: PensieveMemorySummary[] = [];
			for (const row of store.values()) {
				if (opts.type && row.type !== opts.type) continue;
				if (opts.tag && !row.tags.includes(opts.tag)) continue;
				if (opts.pathPrefix && !(row.path === opts.pathPrefix || row.path.startsWith(`${opts.pathPrefix}/`))) continue;
				out.push({
					id: row.id,
					path: row.path,
					tableName: "memories",
					preview: row.text,
					tags: row.tags,
					type: row.type,
					createdAt: Date.now(),
				});
			}
			return out.slice(0, opts.limit ?? 100);
		},
		async get(id: string) {
			const row = store.get(id);
			if (!row) return null;
			return {
				id: row.id,
				content: { text: row.text },
				metadata: row.metadata,
				tags: row.tags,
				path: row.path,
				tableName: "memories",
				preview: row.text,
				hasEmbedding: false,
				type: row.type,
			};
		},
		async update() { return true; },
		async remove(id: string) {
			return store.delete(id);
		},
		async search() { return []; },
		async tree() { return { root: { path: "/", name: "/", count: 0, totalCount: 0, children: [] }, total: 0 }; },
	} as unknown as PensieveMemoryService;
	return { store, service: svc };
}

function makeFakeTrajectoryService(): ActivityTrajectoryService {
	const get = async (id: string) => ({
		trajectory: { id, source: "chat", status: "completed" },
		identity: { id },
		totals: { stepCount: 1, llmCallCount: 1, providerAccessCount: 0, actionCount: 1, totalPromptTokens: 0, totalCompletionTokens: 0, totalLatencyMs: 0 },
		llmCalls: [{ callId: "c1", stepNumber: 1, timestamp: Date.now(), model: "claude-opus-4-7", userPrompt: "build me a token launch dashboard" }],
		providerAccesses: [],
		actions: [{ attemptId: "a1", stepNumber: 1, timestamp: Date.now(), actionName: "CREATE_TASK" }],
		steps: [],
		metadata: {},
		rewardComponents: null,
		metrics: {},
		raw: null,
	});
	return {
		list: async () => ({
			trajectories: [
				{ id: "tj-1", source: "chat", status: "completed", startTime: Date.now() - 60_000 },
			],
			total: 1,
			limit: 40,
			offset: 0,
		}),
		get,
		getMany: async (ids: string[]) => Promise.all(ids.map((id) => get(id))),
		sweepStale: async () => ({ closed: 0, checked: 0 }),
	} as unknown as ActivityTrajectoryService;
}

function makeFakeRuntimeService(modelResponse: string): RuntimeService {
	return {
		peek: () => ({
			useModel: async () => modelResponse,
			getSetting: () => undefined,
		} as never),
		onAfterBuild: () => undefined,
	} as unknown as RuntimeService;
}

describe("DreamService", () => {
	test("runNow parses a valid JSON plan and stages pending changes", async () => {
		const { store, service: memoryService } = makeFakeMemoryService();
		const trajectories = makeFakeTrajectoryService();
		const modelOutput = JSON.stringify({
			additions: [
				{ text: "Dexploarer prefers TypeScript over Python for new tooling", reason: "recurring preference" },
			],
			merges: [],
			replacements: [],
			deletions: [],
			notes: "found one durable preference",
		});
		const runtime = makeFakeRuntimeService(modelOutput);
		const dream = new DreamService({ runtimeService: runtime, memories: memoryService, trajectories });
		const result = await dream.runNow();
		expect(result.skipReason).toBeUndefined();
		expect(result.plan.additions.length).toBe(1);
		expect(result.planId).toBeDefined();

		// Manifest + pending entry were created
		expect(store.size).toBeGreaterThanOrEqual(2);
		const manifests = [...store.values()].filter((m) => m.type === "detour-dream");
		const pendings = [...store.values()].filter((m) => m.type === "detour-dream-pending");
		expect(manifests.length).toBe(1);
		expect(pendings.length).toBe(1);
	});

	test("runNow handles a fenced JSON code block", async () => {
		const { service: memoryService } = makeFakeMemoryService();
		const trajectories = makeFakeTrajectoryService();
		const modelOutput = "```json\n" + JSON.stringify({
			additions: [{ text: "A durable user preference" }],
			merges: [],
			replacements: [],
			deletions: [],
		}) + "\n```";
		const dream = new DreamService({
			runtimeService: makeFakeRuntimeService(modelOutput),
			memories: memoryService,
			trajectories,
		});
		const result = await dream.runNow();
		expect(result.plan.additions.length).toBe(1);
	});

	test("runNow flags parse-failed when model returns prose", async () => {
		const { service: memoryService } = makeFakeMemoryService();
		const trajectories = makeFakeTrajectoryService();
		const dream = new DreamService({
			runtimeService: makeFakeRuntimeService("nope, no JSON here, just prose"),
			memories: memoryService,
			trajectories,
		});
		const result = await dream.runNow();
		expect(result.skipReason).toBe("parse-failed");
	});

	test("runNow flags empty-plan when model returns valid JSON with no changes", async () => {
		const { service: memoryService } = makeFakeMemoryService();
		const trajectories = makeFakeTrajectoryService();
		const dream = new DreamService({
			runtimeService: makeFakeRuntimeService(
				JSON.stringify({ additions: [], merges: [], replacements: [], deletions: [] }),
			),
			memories: memoryService,
			trajectories,
		});
		const result = await dream.runNow();
		expect(result.skipReason).toBe("empty-plan");
	});

	test("apply commits an addition and removes the pending entry", async () => {
		const { store, service: memoryService } = makeFakeMemoryService();
		const trajectories = makeFakeTrajectoryService();
		const modelOutput = JSON.stringify({
			additions: [{ text: "Apply-me preference fact" }],
			merges: [],
			replacements: [],
			deletions: [],
		});
		const dream = new DreamService({
			runtimeService: makeFakeRuntimeService(modelOutput),
			memories: memoryService,
			trajectories,
		});
		const run = await dream.runNow();
		expect(run.planId).toBeDefined();
		const before = [...store.values()].filter((m) => m.type === "detour-dream-pending").length;
		expect(before).toBe(1);
		const applyResult = await dream.apply(run.planId!);
		expect(applyResult.applied).toBeGreaterThanOrEqual(1);
		const after = [...store.values()].filter((m) => m.type === "detour-dream-pending").length;
		expect(after).toBe(0);
		// The addition itself was created
		const addedEntries = [...store.values()].filter((m) => m.tags.includes("dream-applied"));
		expect(addedEntries.length).toBe(1);
		expect(addedEntries[0]?.text).toContain("Apply-me preference fact");
	});

	test("reject drops pending entries without applying", async () => {
		const { store, service: memoryService } = makeFakeMemoryService();
		const trajectories = makeFakeTrajectoryService();
		const dream = new DreamService({
			runtimeService: makeFakeRuntimeService(
				JSON.stringify({
					additions: [{ text: "Reject-me proposed fact" }],
					merges: [],
					replacements: [],
					deletions: [],
				}),
			),
			memories: memoryService,
			trajectories,
		});
		const run = await dream.runNow();
		expect(run.planId).toBeDefined();
		const rejectResult = await dream.reject(run.planId!);
		expect(rejectResult.removed).toBe(1);
		const remaining = [...store.values()].filter((m) => m.type === "detour-dream-pending").length;
		expect(remaining).toBe(0);
		// No new addition memories were committed
		const applied = [...store.values()].filter((m) => m.tags.includes("dream-applied")).length;
		expect(applied).toBe(0);
	});
});
