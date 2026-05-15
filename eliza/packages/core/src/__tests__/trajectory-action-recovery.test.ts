/**
 * Regression test for the "step.action stays pending" bug.
 *
 * Symptom: actions execute correctly but their step.action records in the
 * trajectory remain as the createPendingAction stub. Cause: withChildTrajectoryStep
 * silently no-ops completeActionTrajectoryStep when parentCtx.trajectoryId is
 * undefined, even though parentCtx.trajectoryStepId is present.
 *
 * Recovery: when the parent context only carries a stepId, withChildTrajectoryStep
 * now looks up the owning trajectoryId via the logger's getTrajectoryIdForStep
 * / getTrajectoryIdForStepAsync hooks before creating the child step. This
 * keeps completeStep callable and the action record gets persisted.
 */
import { describe, it, expect, beforeEach } from "bun:test";

import { runWithTrajectoryContext } from "../trajectory-context";
import { withActionStep } from "../trajectory-utils";

type CompleteStepCall = {
	trajectoryId: string;
	stepId: string;
	actionName?: string;
	actionType?: string;
	success?: boolean;
};

function makeFakeRuntime(logger: unknown) {
	return {
		agentId: "00000000-0000-0000-0000-000000000000",
		getService: (type: string) => (type === "trajectories" ? logger : null),
		getServicesByType: (type: string) =>
			type === "trajectories" ? [logger] : [],
	} as unknown as Parameters<typeof withActionStep>[0];
}

describe("withChildTrajectoryStep — trajectoryId recovery", () => {
	let completeCalls: CompleteStepCall[];
	let startStepCalls: Array<{ trajectoryId: string }>;
	let resolveCalls: string[];

	beforeEach(() => {
		completeCalls = [];
		startStepCalls = [];
		resolveCalls = [];
	});

	function makeLogger(overrides: Record<string, unknown> = {}) {
		return {
			isEnabled: () => true,
			startTrajectory: async () => "traj-fake-id",
			startStep: (trajectoryId: string) => {
				startStepCalls.push({ trajectoryId });
				return "child-step-id-from-startStep";
			},
			completeStep: (
				trajectoryId: string,
				stepId: string,
				action: {
					actionName?: string;
					actionType?: string;
					success?: boolean;
				},
			) => {
				completeCalls.push({
					trajectoryId,
					stepId,
					actionName: action.actionName,
					actionType: action.actionType,
					success: action.success,
				});
			},
			logLlmCall: () => undefined,
			endTrajectory: async () => undefined,
			flushWriteQueue: async () => undefined,
			...overrides,
		};
	}

	it("completes the action when parent ctx has both stepId and trajectoryId", async () => {
		const logger = makeLogger();
		const runtime = makeFakeRuntime(logger);

		const parentCtx = {
			trajectoryId: "traj-fake-id",
			trajectoryStepId: "parent-step-id",
		};

		await runWithTrajectoryContext(parentCtx, async () => {
			await withActionStep(runtime, "REPLY", async () => ({ text: "hi" }));
		});

		expect(completeCalls).toHaveLength(1);
		expect(completeCalls[0]!.actionName).toBe("REPLY");
		expect(completeCalls[0]!.success).toBe(true);
		expect(completeCalls[0]!.trajectoryId).toBe("traj-fake-id");
	});

	it("recovers trajectoryId via sync resolver when parent ctx only has stepId", async () => {
		const logger = makeLogger({
			getTrajectoryIdForStep: (stepId: string) => {
				resolveCalls.push(stepId);
				return "traj-recovered-sync";
			},
		});
		const runtime = makeFakeRuntime(logger);

		const parentCtx = {
			trajectoryStepId: "parent-step-id-no-traj-id",
		};

		await runWithTrajectoryContext(parentCtx, async () => {
			await withActionStep(runtime, "GENERATE_IMAGE", async () => ({
				success: true,
			}));
		});

		expect(resolveCalls).toEqual(["parent-step-id-no-traj-id"]);
		expect(completeCalls).toHaveLength(1);
		expect(completeCalls[0]!.actionName).toBe("GENERATE_IMAGE");
		expect(completeCalls[0]!.trajectoryId).toBe("traj-recovered-sync");
	});

	it("falls back to async resolver when sync resolver returns null", async () => {
		const asyncCalls: string[] = [];
		const logger = makeLogger({
			getTrajectoryIdForStep: (stepId: string) => {
				resolveCalls.push(stepId);
				return null;
			},
			getTrajectoryIdForStepAsync: async (stepId: string) => {
				asyncCalls.push(stepId);
				return "traj-recovered-async";
			},
		});
		const runtime = makeFakeRuntime(logger);

		const parentCtx = {
			trajectoryStepId: "parent-step-id-async-only",
		};

		await runWithTrajectoryContext(parentCtx, async () => {
			await withActionStep(runtime, "SEND_DM", async () => ({ ok: true }));
		});

		expect(resolveCalls).toEqual(["parent-step-id-async-only"]);
		expect(asyncCalls).toEqual(["parent-step-id-async-only"]);
		expect(completeCalls).toHaveLength(1);
		expect(completeCalls[0]!.trajectoryId).toBe("traj-recovered-async");
		expect(completeCalls[0]!.actionName).toBe("SEND_DM");
	});

	it("backfills parent ctx.trajectoryId so sibling steps benefit from the lookup", async () => {
		const logger = makeLogger({
			getTrajectoryIdForStep: () => "traj-from-recovery",
		});
		const runtime = makeFakeRuntime(logger);

		const parentCtx: { trajectoryStepId: string; trajectoryId?: string } = {
			trajectoryStepId: "parent-step",
		};

		await runWithTrajectoryContext(parentCtx, async () => {
			await withActionStep(runtime, "FIRST", async () => ({ ok: true }));
		});

		// Outside the runWithTrajectoryContext scope the AsyncLocalStorage
		// store no longer exposes our object — what we can verify is that
		// the SAME context object that was passed in was mutated in place,
		// which we'll see via the second action receiving the same trajectoryId
		// without triggering the resolver a second time.
		expect(parentCtx.trajectoryId).toBe("traj-from-recovery");

		const resolverCalls: string[] = [];
		const logger2 = makeLogger({
			getTrajectoryIdForStep: (stepId: string) => {
				resolverCalls.push(stepId);
				return "should-not-be-called";
			},
		});
		const runtime2 = makeFakeRuntime(logger2);

		// With a parentCtx whose trajectoryId is already populated (as the
		// backfill above did), the resolver MUST NOT be called.
		await runWithTrajectoryContext(parentCtx, async () => {
			await withActionStep(runtime2, "SECOND", async () => ({ ok: true }));
		});
		expect(resolverCalls).toEqual([]);
	});

	it("still bails when both stepId AND trajectoryId are missing", async () => {
		const logger = makeLogger({
			getTrajectoryIdForStep: () => "never-called",
		});
		const runtime = makeFakeRuntime(logger);

		// No parent context at all — withChildTrajectoryStep must just run fn.
		await runWithTrajectoryContext(undefined, async () => {
			await withActionStep(runtime, "ORPHAN", async () => ({ ok: true }));
		});

		expect(completeCalls).toHaveLength(0);
		expect(startStepCalls).toHaveLength(0);
	});
});
