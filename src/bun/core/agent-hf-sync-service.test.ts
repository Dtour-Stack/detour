import { describe, expect, test } from "bun:test";
import type { IAgentRuntime } from "@elizaos/core";
import type { AgentHfSyncPolicy, AgentHfSyncState } from "../../shared/index";
import { AgentHfSyncService } from "./agent-hf-sync-service";

const COUNTS = {
	trajectories: 1,
	trajectoryDetails: 1,
	memories: 1,
	memoryTables: 1,
	relationships: 1,
	redactedMemories: 0,
	totalTrajectoriesScanned: 1,
	totalMemoriesScanned: 1,
	dataBytes: 128,
};

function basePolicy(): AgentHfSyncPolicy {
	return {
		enabled: true,
		destination: "hf://buckets/dexploarer/detourdump",
		limit: 200,
		syncOnStartup: true,
		daily: false,
		dailyTimeUtc: "03:00",
		everyNewTrajectories: 50,
		minIntervalMinutes: 1,
		failureCooldownMinutes: 1,
		pruneAfterSync: true,
		retentionCount: 200,
	};
}

function baseState(): AgentHfSyncState {
	return {
		lastAttemptAt: null,
		lastSuccessAt: null,
		lastFailureAt: null,
		lastError: null,
		lastReason: null,
		lastSyncedTrajectoryTotal: null,
		lastObservedTrajectoryTotal: null,
		lastDailySyncDateUtc: null,
		lastCounts: null,
	};
}

async function waitForDone(jobId: string, service: AgentHfSyncService): Promise<void> {
	for (let i = 0; i < 20; i++) {
		const job = service.getJob(jobId);
		if (job?.status !== "running") return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("job did not finish");
}

function makeService(args: {
	policy?: AgentHfSyncPolicy;
	state?: AgentHfSyncState;
	total?: number;
}) {
	let policy = args.policy ?? basePolicy();
	let state = args.state ?? baseState();
	const runtime = { character: { name: "Test Agent" } } as IAgentRuntime;
	const service = new AgentHfSyncService({
		runtime: { peek: () => runtime },
		config: {
			getAgentHfSyncPolicy: async () => policy,
			setAgentHfSyncPolicy: async (next) => {
				policy = next;
				return policy;
			},
			getAgentHfSyncState: async () => state,
			setAgentHfSyncState: async (next) => {
				state = next;
				return state;
			},
		},
		trajectories: {
			list: async () => ({
				trajectories: [],
				total: args.total ?? 0,
				limit: 1,
				offset: 0,
			}),
			prune: async () => ({ trajectoriesDeleted: 0, vacuumed: false }),
		},
		sync: async (_runtime, options) => ({
			destination: options.destination ?? policy.destination,
			command: `hf sync ./data ${options.destination ?? policy.destination}`,
			stdout: "",
			stderr: "",
			counts: COUNTS,
			summary: "ok",
		}),
		checkIntervalMs: 60_000,
	});
	return { service, getState: () => state };
}

describe("AgentHfSyncService", () => {
	test("syncs on startup when enabled and no prior success exists", async () => {
		const { service, getState } = makeService({ total: 7 });
		const job = await service.checkNow(new Date("2026-05-14T01:00:00Z"));
		expect(job?.reason).toBe("startup");
		if (!job) throw new Error("expected job");
		await waitForDone(job.id, service);
		expect(service.getJob(job.id)?.status).toBe("succeeded");
		expect(getState().lastReason).toBe("startup");
		expect(getState().lastSyncedTrajectoryTotal).toBe(7);
		expect(getState().lastCounts?.dataBytes).toBe(128);
	});

	test("syncs after configured new trajectory threshold", async () => {
		const policy = { ...basePolicy(), syncOnStartup: false, everyNewTrajectories: 5 };
		const state = {
			...baseState(),
			lastAttemptAt: "2026-05-13T00:00:00.000Z",
			lastSuccessAt: "2026-05-13T00:00:00.000Z",
			lastSyncedTrajectoryTotal: 10,
			lastObservedTrajectoryTotal: 10,
		};
		const { service, getState } = makeService({ policy, state, total: 16 });
		const job = await service.checkNow(new Date("2026-05-14T01:00:00Z"));
		expect(job?.reason).toBe("trajectory-threshold");
		if (!job) throw new Error("expected job");
		await waitForDone(job.id, service);
		expect(getState().lastReason).toBe("trajectory-threshold");
		expect(getState().lastSyncedTrajectoryTotal).toBe(16);
	});
});
