import { describe, expect, test } from "bun:test";
import { ActivityTasksService } from "./tasks-service";

function makeRuntime(overrides: Record<string, unknown> = {}) {
	const tasks: Record<string, Record<string, unknown>> = {};
	const taskWorkers = new Map<string, { name: string; shouldRun?: unknown; canExecute?: unknown }>();
	const runtime = {
		taskWorkers,
		getTasks: async () => Object.values(tasks),
		getTask: async (id: string) => tasks[id] ?? null,
		updateTask: async (id: string, patch: Record<string, unknown>) => {
			const existing = tasks[id];
			if (existing) tasks[id] = { ...existing, ...patch };
		},
		deleteTask: async (id: string) => {
			delete tasks[id];
		},
		getService: () => ({ runDueTasks: async () => undefined }),
		_tasks: tasks,
		...overrides,
	};
	return runtime;
}

describe("ActivityTasksService", () => {
	test("returns empty snapshot when runtime is null", async () => {
		const svc = new ActivityTasksService(() => null);
		const snap = await svc.snapshot();
		expect(snap.available).toBe(false);
		expect(snap.workers).toEqual([]);
		expect(snap.tasks).toEqual([]);
	});

	test("enumerates registered task workers and sorts alphabetically", async () => {
		const runtime = makeRuntime();
		runtime.taskWorkers.set("ZOO_TASK", { name: "ZOO_TASK", shouldRun: () => true });
		runtime.taskWorkers.set("ALPHA_TASK", { name: "ALPHA_TASK" });
		const svc = new ActivityTasksService(() => runtime as never);
		const snap = await svc.snapshot();
		expect(snap.available).toBe(true);
		expect(snap.workers.map((w) => w.name)).toEqual(["ALPHA_TASK", "ZOO_TASK"]);
		expect(snap.workers[0]!.hasShouldRun).toBe(false);
		expect(snap.workers[1]!.hasShouldRun).toBe(true);
		expect(snap.totals.workerCount).toBe(2);
	});

	test("normalizes recurring vs one-shot tasks", async () => {
		const runtime = makeRuntime();
		runtime.taskWorkers.set("BATCHER_DRAIN", { name: "BATCHER_DRAIN" });
		const lastRun = Date.now() - 30_000;
		(runtime as { _tasks: Record<string, Record<string, unknown>> })._tasks.recurring = {
			id: "recurring",
			name: "BATCHER_DRAIN",
			tags: ["scheduler"],
			metadata: { updateInterval: 60_000, lastExecuted: lastRun, failureCount: 0 },
		};
		(runtime as { _tasks: Record<string, Record<string, unknown>> })._tasks.oneshot = {
			id: "oneshot",
			name: "BATCHER_DRAIN",
			tags: [],
			dueAt: Date.now() + 5000,
			metadata: {},
		};
		const svc = new ActivityTasksService(() => runtime as never);
		const snap = await svc.snapshot();
		expect(snap.tasks.length).toBe(2);
		const rec = snap.tasks.find((t) => t.id === "recurring")!;
		expect(rec.updateInterval).toBe(60_000);
		expect(rec.nextRunAt).toBe(lastRun + 60_000);
		expect(rec.hasWorker).toBe(true);
		expect(snap.totals.recurringCount).toBe(1);
	});

	test("flags orphaned tasks (no matching worker) and failing tasks", async () => {
		const runtime = makeRuntime();
		(runtime as { _tasks: Record<string, Record<string, unknown>> })._tasks.orphan = {
			id: "orphan",
			name: "MISSING_WORKER",
			tags: [],
			metadata: { failureCount: 3, lastError: "boom" },
		};
		const svc = new ActivityTasksService(() => runtime as never);
		const snap = await svc.snapshot();
		const t = snap.tasks[0]!;
		expect(t.hasWorker).toBe(false);
		expect(t.failureCount).toBe(3);
		expect(t.lastError).toBe("boom");
		expect(snap.totals.failingCount).toBe(1);
	});

	test("sorts paused tasks last", async () => {
		const runtime = makeRuntime();
		runtime.taskWorkers.set("W", { name: "W" });
		(runtime as { _tasks: Record<string, Record<string, unknown>> })._tasks.paused = {
			id: "paused",
			name: "W",
			tags: [],
			metadata: { paused: true, updateInterval: 10_000, lastExecuted: Date.now() - 5_000 },
		};
		(runtime as { _tasks: Record<string, Record<string, unknown>> })._tasks.active = {
			id: "active",
			name: "W",
			tags: [],
			metadata: { updateInterval: 10_000, lastExecuted: Date.now() - 5_000 },
		};
		const svc = new ActivityTasksService(() => runtime as never);
		const snap = await svc.snapshot();
		expect(snap.tasks[0]!.id).toBe("active");
		expect(snap.tasks[1]!.id).toBe("paused");
		expect(snap.totals.pausedCount).toBe(1);
	});

	test("pause flips metadata.paused", async () => {
		const runtime = makeRuntime();
		(runtime as { _tasks: Record<string, Record<string, unknown>> })._tasks.t = {
			id: "t",
			name: "X",
			tags: [],
			metadata: { foo: "bar" },
		};
		const svc = new ActivityTasksService(() => runtime as never);
		await svc.pause("t", true);
		const t = (runtime as { _tasks: Record<string, Record<string, unknown>> })._tasks.t;
		const meta = t!.metadata as Record<string, unknown>;
		expect(meta.paused).toBe(true);
		expect(meta.foo).toBe("bar");
	});

	test("runNow clears lastExecuted and pokes the scheduler", async () => {
		const runtime = makeRuntime();
		let scheduleNudged = false;
		(runtime as { getService: () => unknown }).getService = () => ({
			runDueTasks: async () => {
				scheduleNudged = true;
			},
		});
		(runtime as { _tasks: Record<string, Record<string, unknown>> })._tasks.t = {
			id: "t",
			name: "X",
			tags: [],
			metadata: { lastExecuted: Date.now() - 1000, updateInterval: 60_000 },
		};
		const svc = new ActivityTasksService(() => runtime as never);
		await svc.runNow("t");
		const t = (runtime as { _tasks: Record<string, Record<string, unknown>> })._tasks.t;
		const meta = t!.metadata as Record<string, unknown>;
		expect(meta.lastExecuted).toBeUndefined();
		expect(scheduleNudged).toBe(true);
	});
});
