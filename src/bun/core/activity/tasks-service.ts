/**
 * Activity > Tasks pane.
 *
 * Surfaces elizaOS's TaskService for observability:
 *  - registered task workers (action types the agent can do autonomously)
 *  - persisted Tasks (recurring + one-shot) with paused/failure/lastRun status
 *  - run-now / pause / resume / delete controls
 *
 * elizaOS's TaskService runs a 1Hz tick that calls the registered worker.
 * Recurring tasks have `metadata.updateInterval`; one-shots don't.
 * Worker registration: `runtime.registerTaskWorker(...)`. Workers are stored
 * on `runtime.taskWorkers` (private Map). We access it through the same
 * loose-typed shape we use for other internals.
 */

import type { IAgentRuntime } from "@elizaos/core";

const TASK_SERVICE_TYPE = "task";

interface RuntimeTaskShape {
	taskWorkers?: Map<string, { name: string; shouldRun?: unknown; canExecute?: unknown }>;
	getTasks?: (params: { tags?: string[]; limit?: number }) => Promise<unknown[]>;
	getTask?: (id: string) => Promise<unknown | null>;
	updateTask?: (id: string, task: Record<string, unknown>) => Promise<void>;
	deleteTask?: (id: string) => Promise<void>;
	getService?: (type: string) => unknown;
}

interface TaskServiceShape {
	getTaskStatus?: (id: string) => Promise<{
		task: Record<string, unknown> | null;
		paused: boolean;
		executing: boolean;
		nextRunAt?: number;
		lastError?: string;
	}>;
	runDueTasks?: () => Promise<void>;
}

export interface ActivityTaskWorker {
	name: string;
	hasShouldRun: boolean;
	hasCanExecute: boolean;
}

export interface ActivityTaskRecord {
	id: string;
	name: string;
	description?: string;
	tags: string[];
	roomId?: string;
	worldId?: string;
	entityId?: string;
	createdAt?: number;
	updatedAt?: number;
	dueAt?: number;
	/** ms between runs (recurring task), undefined for one-shots. */
	updateInterval?: number;
	/** Estimated next run timestamp (lastExecuted + updateInterval). */
	nextRunAt?: number;
	lastExecuted?: number;
	lastError?: string;
	failureCount: number;
	maxFailures?: number;
	paused: boolean;
	hasWorker: boolean;
	metadata: Record<string, unknown>;
}

export interface ActivityTasksSnapshot {
	available: boolean;
	workers: ActivityTaskWorker[];
	tasks: ActivityTaskRecord[];
	totals: {
		workerCount: number;
		taskCount: number;
		recurringCount: number;
		pausedCount: number;
		failingCount: number;
	};
}

const EMPTY_SNAPSHOT: ActivityTasksSnapshot = {
	available: false,
	workers: [],
	tasks: [],
	totals: { workerCount: 0, taskCount: 0, recurringCount: 0, pausedCount: 0, failingCount: 0 },
};

function asString(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "bigint") return Number(v);
	return undefined;
}
function asBool(v: unknown): boolean {
	return v === true;
}
function asObject(v: unknown): Record<string, unknown> {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function optionalStringField(source: Record<string, unknown>, key: string): Record<string, string> {
	const value = asString(source[key]);
	return value === undefined ? {} : { [key]: value };
}

function optionalNumberField(source: Record<string, unknown>, key: string): Record<string, number> {
	const value = asNumber(source[key]);
	return value === undefined ? {} : { [key]: value };
}

function taskTiming(t: Record<string, unknown>, meta: Record<string, unknown>): Pick<
	ActivityTaskRecord,
	"updateInterval" | "nextRunAt" | "lastExecuted"
> {
	const updateInterval = asNumber(meta.updateInterval);
	const lastExecuted = asNumber(
		typeof meta.lastExecuted === "string"
			? Date.parse(meta.lastExecuted)
			: meta.lastExecuted,
	) ?? asNumber(meta.updatedAt) ?? asNumber(t.updatedAt);
	const nextRunAt =
		updateInterval && lastExecuted ? lastExecuted + updateInterval : asNumber(t.dueAt);
	return {
		...(updateInterval !== undefined && { updateInterval }),
		...(nextRunAt !== undefined && { nextRunAt }),
		...(lastExecuted !== undefined && { lastExecuted }),
	};
}

function normalizeTask(raw: unknown, knownWorkerNames: Set<string>): ActivityTaskRecord | null {
	const t = asObject(raw);
	const id = asString(t.id);
	if (!id) return null;
	const meta = asObject(t.metadata);
	const tags = Array.isArray(t.tags) ? (t.tags as unknown[]).map(String) : [];
	return {
		id,
		name: asString(t.name) ?? "(unnamed)",
		...optionalStringField(t, "description"),
		tags,
		...optionalStringField(t, "roomId"),
		...optionalStringField(t, "worldId"),
		...optionalStringField(t, "entityId"),
		...optionalNumberField(t, "createdAt"),
		...optionalNumberField(t, "updatedAt"),
		...optionalNumberField(t, "dueAt"),
		...taskTiming(t, meta),
		...optionalStringField(meta, "lastError"),
		failureCount: asNumber(meta.failureCount) ?? 0,
		...optionalNumberField(meta, "maxFailures"),
		paused: asBool(meta.paused),
		hasWorker: knownWorkerNames.has(asString(t.name) ?? ""),
		metadata: meta,
	};
}

export class ActivityTasksService {
	constructor(private readonly resolveRuntime: () => IAgentRuntime | null) {}

	async snapshot(): Promise<ActivityTasksSnapshot> {
		const runtime = this.resolveRuntime();
		if (!runtime) return EMPTY_SNAPSHOT;
		const r = runtime as unknown as RuntimeTaskShape;

		const workers: ActivityTaskWorker[] = [];
		if (r.taskWorkers) {
			for (const [name, w] of r.taskWorkers.entries()) {
				workers.push({
					name,
					hasShouldRun: typeof w.shouldRun === "function",
					hasCanExecute: typeof w.canExecute === "function",
				});
			}
		}
		workers.sort((a, b) => a.name.localeCompare(b.name));

		const known = new Set(workers.map((w) => w.name));
		const tasks: ActivityTaskRecord[] = [];
		try {
			const raw = (await r.getTasks?.({ tags: [] })) ?? [];
			for (const item of raw) {
				const norm = normalizeTask(item, known);
				if (norm) tasks.push(norm);
			}
		} catch {
			// adapter may throw if storage isn't ready; treat as no tasks.
		}

		// Sort: paused last, then by next-run-soon first, then by name.
		tasks.sort((a, b) => {
			if (a.paused !== b.paused) return a.paused ? 1 : -1;
			const an = a.nextRunAt ?? Number.POSITIVE_INFINITY;
			const bn = b.nextRunAt ?? Number.POSITIVE_INFINITY;
			if (an !== bn) return an - bn;
			return a.name.localeCompare(b.name);
		});

		return {
			available: true,
			workers,
			tasks,
			totals: {
				workerCount: workers.length,
				taskCount: tasks.length,
				recurringCount: tasks.filter((t) => typeof t.updateInterval === "number").length,
				pausedCount: tasks.filter((t) => t.paused).length,
				failingCount: tasks.filter((t) => t.failureCount > 0).length,
			},
		};
	}

	async pause(id: string, paused: boolean): Promise<boolean> {
		const runtime = this.resolveRuntime();
		if (!runtime) return false;
		const r = runtime as unknown as RuntimeTaskShape;
		const existing = (await r.getTask?.(id)) as Record<string, unknown> | null | undefined;
		if (!existing) return false;
		const meta = asObject(existing.metadata);
		const nextMeta = { ...meta, paused };
		await r.updateTask?.(id, { metadata: nextMeta });
		return true;
	}

	async remove(id: string): Promise<boolean> {
		const runtime = this.resolveRuntime();
		if (!runtime) return false;
		const r = runtime as unknown as RuntimeTaskShape;
		await r.deleteTask?.(id);
		return true;
	}

	/**
	 * Best-effort "run now" — clears `lastExecuted` so the next scheduler tick
	 * picks the task up immediately, then nudges runDueTasks() if available.
	 */
	async runNow(id: string): Promise<boolean> {
		const runtime = this.resolveRuntime();
		if (!runtime) return false;
		const r = runtime as unknown as RuntimeTaskShape;
		const existing = (await r.getTask?.(id)) as Record<string, unknown> | null | undefined;
		if (!existing) return false;
		const meta = asObject(existing.metadata);
		const nextMeta = { ...meta };
		delete nextMeta.updatedAt;
		delete nextMeta.lastExecuted;
		await r.updateTask?.(id, { metadata: nextMeta, dueAt: Date.now() });
		const taskService = r.getService?.(TASK_SERVICE_TYPE) as TaskServiceShape | undefined;
		try {
			await taskService?.runDueTasks?.();
		} catch {
			// scheduler may be busy; the next tick will pick it up.
		}
		return true;
	}
}
