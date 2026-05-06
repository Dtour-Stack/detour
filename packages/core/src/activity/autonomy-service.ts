/**
 * Activity > Autonomy pane.
 *
 * Wraps elizaOS's AutonomyService (serviceType "AUTONOMY"). Lets the user:
 *  - see whether autonomy is enabled + currently running
 *  - read/set the loop interval (recreates the batcher section internally)
 *  - flip enable/disable
 *
 * The underlying service is registered when @elizaos/plugin-bootstrap or the
 * basic-capabilities feature is loaded — we resolve via runtime.getService().
 */

import type { IAgentRuntime, Task, TaskMetadata, UUID } from "@elizaos/core";
import type { ActivityXAutonomyUpdate } from "@detour/shared";
import { CONTINUOUS_IMPROVEMENT_TASK_NAME } from "../continuous-improvement-service";

const AUTONOMY_SERVICE_TYPE = "AUTONOMY";
const X_AUTONOMY_TASK_NAME = "X_AUTONOMY";
const X_AUTONOMY_TASK_TAGS = ["queue", "repeat", "x-autonomy"];
const AUTONOMY_TASK_NAMES = new Set(["AUTONOMY_THINK", X_AUTONOMY_TASK_NAME, "BATCHER_DRAIN", CONTINUOUS_IMPROVEMENT_TASK_NAME]);
const AUTONOMY_TASK_TAGS = new Set(["autonomy", "x-autonomy", "batcher", "continuous-improvement"]);
const X_AUTONOMY_DEFAULT_INTERVAL_MS = 60_000;
const X_AUTONOMY_DEFAULT_STATUS_INTERVAL_MS = 2 * 60 * 60 * 1000;
const X_AUTONOMY_DEFAULT_DISCOVERY_INTERVAL_MS = 10 * 60_000;
const X_AUTONOMY_DEFAULT_MAX_REPLIES = 2;
const X_AUTONOMY_DEFAULT_MAX_DISCOVERY = 2;
const X_AUTONOMY_DEFAULT_DISCOVERY_QUERIES = [
	"elizaOS",
	"Dexploarer",
	"ai agents",
	"autonomous agents",
	"agent framework",
	"personal AI",
	"developer tools",
];

export interface ActivityAutonomySnapshot {
	available: boolean;
	enabled: boolean;
	running: boolean;
	thinking: boolean;
	intervalMs: number;
	runner: "prompt-batcher" | "task" | "missing" | "none";
	autonomousRoomId?: string;
	tasks: ActivityAutonomyTask[];
	x: ActivityXAutonomySnapshot;
	improvement: ActivityImprovementSnapshot;
}

export interface ActivityAutonomyTask {
	id: string;
	name: string;
	description?: string;
	tags: string[];
	updateInterval?: number;
	nextRunAt?: number;
	lastExecuted?: number;
	lastError?: string;
	failureCount: number;
	paused: boolean;
	hasWorker: boolean;
}

export interface ActivityXAutonomySnapshot {
	available: boolean;
	enabled: boolean;
	writeEnabled: boolean;
	statusPostingEnabled: boolean;
	discoveryEnabled: boolean;
	proactiveEngagementEnabled: boolean;
	followEnabled: boolean;
	intervalMs: number;
	statusIntervalMs: number;
	discoveryIntervalMs: number;
	maxRepliesPerTick: number;
	maxDiscoveryPerTick: number;
	discoveryQueries: string[];
	lastRunAt?: number;
	lastStatusAt?: number;
	lastDiscoveryAt?: number;
	lastStatusTweetId?: string;
	lastHandledCount: number;
	lastHandled: ActivityXAutonomyHandled[];
}

export interface ActivityXAutonomyHandled {
	action: string;
	success?: boolean;
	tweetId?: string;
	resultTweetId?: string;
	error?: string;
	reason?: string;
	text?: string;
	authorScreenName?: string;
	query?: string;
	score?: number;
}

export interface ActivityImprovementSnapshot {
	available: boolean;
	enabled: boolean;
	intervalMs: number;
	lastRunAt?: number;
	lastResult?: string;
	lastCategory?: string;
	lastProposal?: string;
	lastError?: string;
	lastMemoryIds: string[];
}

interface AutonomyServiceShape {
	getStatus?: () => {
		enabled: boolean;
		running: boolean;
		thinking?: boolean;
		interval: number;
		autonomousRoomId?: string;
	};
	enableAutonomy?: () => Promise<void>;
	disableAutonomy?: () => Promise<void>;
	getLoopInterval?: () => number;
	setLoopInterval?: (ms: number) => Promise<void> | void;
}

interface RuntimeTaskShape {
	agentId?: UUID;
	taskWorkers?: Map<string, { name: string }>;
	getTasks?: (params: { agentIds?: string[]; tags?: string[]; limit?: number }) => Promise<Task[]>;
	createTask?: (task: Task) => Promise<UUID>;
	updateTask?: (id: UUID, task: Partial<Task>) => Promise<void>;
	getSetting?: (key: string) => string | boolean | number | undefined | null;
	setSetting?: (key: string, value: string | boolean | null, secret?: boolean) => void;
	promptBatcher?: unknown;
}

const EMPTY: ActivityAutonomySnapshot = {
	available: false,
	enabled: false,
	running: false,
	thinking: false,
	intervalMs: 0,
	runner: "none",
	tasks: [],
	x: {
		available: false,
		enabled: false,
		writeEnabled: false,
		statusPostingEnabled: false,
		discoveryEnabled: false,
		proactiveEngagementEnabled: false,
		followEnabled: false,
		intervalMs: X_AUTONOMY_DEFAULT_INTERVAL_MS,
		statusIntervalMs: X_AUTONOMY_DEFAULT_STATUS_INTERVAL_MS,
		discoveryIntervalMs: X_AUTONOMY_DEFAULT_DISCOVERY_INTERVAL_MS,
		maxRepliesPerTick: 0,
		maxDiscoveryPerTick: 0,
		discoveryQueries: [],
		lastHandledCount: 0,
		lastHandled: [],
	},
	improvement: {
		available: false,
		enabled: false,
		intervalMs: 30 * 60_000,
		lastMemoryIds: [],
	},
};

function findService(runtime: IAgentRuntime): AutonomyServiceShape | null {
	const r = runtime as unknown as {
		getService?: (t: string) => unknown;
		getServicesByType?: (t: string) => unknown[];
	};
	const first = r.getService?.(AUTONOMY_SERVICE_TYPE);
	if (first) return first as AutonomyServiceShape;
	const all = r.getServicesByType?.(AUTONOMY_SERVICE_TYPE) ?? [];
	return (all[0] as AutonomyServiceShape) ?? null;
}

function asString(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "bigint") return Number(v);
	if (v instanceof Date) return v.getTime();
	return undefined;
}

function asObject(v: unknown): Record<string, unknown> {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function readTimestamp(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
	}
	return undefined;
}

function setting(runtime: RuntimeTaskShape, key: string): string | undefined {
	const v = runtime.getSetting?.(key);
	if (typeof v === "string" && v.trim().length > 0) return v;
	if (typeof v === "boolean" || typeof v === "number") return String(v);
	return undefined;
}

function booleanSetting(runtime: RuntimeTaskShape, key: string, defaultValue: boolean): boolean {
	const v = setting(runtime, key);
	if (v === undefined) return defaultValue;
	return !["0", "false", "no", "off"].includes(v.trim().toLowerCase());
}

function numberSetting(runtime: RuntimeTaskShape, key: string, defaultValue: number): number {
	const v = setting(runtime, key);
	if (v === undefined) return defaultValue;
	const n = Number(v);
	return Number.isFinite(n) ? n : defaultValue;
}

function listSetting(runtime: RuntimeTaskShape, key: string, defaultValue: string[]): string[] {
	const v = setting(runtime, key);
	if (!v) return [...defaultValue];
	const parsed = v
		.split(/[\n,]+/)
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
	return parsed.length > 0 ? parsed : [...defaultValue];
}

function clampNumber(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Math.round(value)));
}

export function xAutonomyRuntimeSettings(update: ActivityXAutonomyUpdate): Array<[string, string]> {
	const entries: Array<[string, string]> = [];
	const bool = (field: keyof ActivityXAutonomyUpdate, key: string) => {
		const value = update[field];
		if (typeof value === "boolean") entries.push([key, value ? "true" : "false"]);
	};
	const num = (field: keyof ActivityXAutonomyUpdate, key: string, min: number, max: number) => {
		const value = update[field];
		if (typeof value === "number" && Number.isFinite(value)) {
			entries.push([key, String(clampNumber(value, min, max))]);
		}
	};
	bool("enabled", "X_AUTONOMY_ENABLED");
	bool("writeEnabled", "X_AUTONOMY_WRITE");
	bool("statusPostingEnabled", "X_AUTONOMY_POST_STATUS_ENABLED");
	bool("discoveryEnabled", "X_AUTONOMY_DISCOVERY_ENABLED");
	bool("proactiveEngagementEnabled", "X_AUTONOMY_PROACTIVE_ENGAGEMENT_ENABLED");
	bool("followEnabled", "X_AUTONOMY_FOLLOW_ENABLED");
	num("intervalMs", "X_AUTONOMY_INTERVAL_MS", 30_000, 30 * 60_000);
	num("statusIntervalMs", "X_AUTONOMY_STATUS_INTERVAL_MS", 15 * 60_000, 24 * 60 * 60_000);
	num("discoveryIntervalMs", "X_AUTONOMY_DISCOVERY_INTERVAL_MS", 5 * 60_000, 24 * 60 * 60_000);
	num("maxRepliesPerTick", "X_AUTONOMY_MAX_REPLIES_PER_TICK", 1, 5);
	num("maxDiscoveryPerTick", "X_AUTONOMY_MAX_DISCOVERY_PER_TICK", 0, 8);
	if (Array.isArray(update.discoveryQueries)) {
		const queries = update.discoveryQueries.map((item) => item.trim()).filter((item) => item.length > 0);
		entries.push(["X_AUTONOMY_DISCOVERY_QUERIES", queries.join("\n")]);
	}
	return entries;
}

function xTaskMetadata(current: unknown, runtime: RuntimeTaskShape): TaskMetadata {
	const intervalMs = Math.max(
		30_000,
		Math.min(30 * 60_000, numberSetting(runtime, "X_AUTONOMY_INTERVAL_MS", X_AUTONOMY_DEFAULT_INTERVAL_MS)),
	);
	return {
		...asObject(current),
		updateInterval: intervalMs,
		baseInterval: intervalMs,
		blocking: false,
		xAutonomy: {
			version: 1,
		},
	};
}

function isXTask(task: Task): boolean {
	return task.name === X_AUTONOMY_TASK_NAME && Boolean(asObject(task.metadata).xAutonomy);
}

function normalizeTask(raw: unknown, knownWorkerNames: Set<string>): ActivityAutonomyTask | null {
	const t = asObject(raw);
	const id = asString(t.id);
	if (!id) return null;
	const meta = asObject(t.metadata);
	const tags = Array.isArray(t.tags) ? t.tags.map(String) : [];
	const name = asString(t.name) ?? "(unnamed)";
	const updateInterval = asNumber(meta.updateInterval);
	const lastExecuted =
		readTimestamp(meta.lastExecuted) ?? asNumber(meta.updatedAt) ?? asNumber(t.updatedAt);
	const nextRunAt =
		updateInterval && lastExecuted ? lastExecuted + updateInterval : asNumber(t.dueAt);
	return {
		id,
		name,
		...(asString(t.description) !== undefined && { description: asString(t.description)! }),
		tags,
		...(updateInterval !== undefined && { updateInterval }),
		...(nextRunAt !== undefined && { nextRunAt }),
		...(lastExecuted !== undefined && { lastExecuted }),
		...(asString(meta.lastError) !== undefined && { lastError: asString(meta.lastError)! }),
		failureCount: asNumber(meta.failureCount) ?? 0,
		paused: meta.paused === true,
		hasWorker: knownWorkerNames.has(name),
	};
}

function isAutonomyTask(task: ActivityAutonomyTask): boolean {
	return AUTONOMY_TASK_NAMES.has(task.name) || task.tags.some((tag) => AUTONOMY_TASK_TAGS.has(tag));
}

function normalizeHandled(raw: unknown): ActivityXAutonomyHandled[] {
	if (!Array.isArray(raw)) return [];
	return raw.slice(-10).flatMap((item) => {
		const h = asObject(item);
		const action = asString(h.action);
		if (!action) return [];
		return [{
			action,
			...(typeof h.success === "boolean" && { success: h.success }),
			...(asString(h.tweetId) !== undefined && { tweetId: asString(h.tweetId)! }),
			...(asString(h.resultTweetId) !== undefined && { resultTweetId: asString(h.resultTweetId)! }),
			...(asString(h.error) !== undefined && { error: asString(h.error)! }),
			...(asString(h.reason) !== undefined && { reason: asString(h.reason)! }),
			...(asString(h.text) !== undefined && { text: asString(h.text)! }),
			...(asString(h.authorScreenName) !== undefined && { authorScreenName: asString(h.authorScreenName)! }),
			...(asString(h.query) !== undefined && { query: asString(h.query)! }),
			...(asNumber(h.score) !== undefined && { score: asNumber(h.score)! }),
		}];
	});
}

function xSnapshot(runtime: RuntimeTaskShape, tasks: ActivityAutonomyTask[], rawTasks: unknown[]): ActivityXAutonomySnapshot {
	const rawXTask = rawTasks.find((task) => asString(asObject(task).name) === X_AUTONOMY_TASK_NAME);
	const metadata = asObject(asObject(rawXTask).metadata);
	const lastHandled = normalizeHandled(metadata.xAutonomyLastHandled);
	const intervalMs = Math.max(
		30_000,
		Math.min(30 * 60_000, numberSetting(runtime, "X_AUTONOMY_INTERVAL_MS", X_AUTONOMY_DEFAULT_INTERVAL_MS)),
	);
	const statusIntervalMs = Math.max(
		15 * 60_000,
		Math.min(24 * 60 * 60_000, numberSetting(runtime, "X_AUTONOMY_STATUS_INTERVAL_MS", X_AUTONOMY_DEFAULT_STATUS_INTERVAL_MS)),
	);
	const discoveryIntervalMs = Math.max(
		5 * 60_000,
		Math.min(
			24 * 60 * 60_000,
			numberSetting(runtime, "X_AUTONOMY_DISCOVERY_INTERVAL_MS", X_AUTONOMY_DEFAULT_DISCOVERY_INTERVAL_MS),
		),
	);
	const maxRepliesPerTick = Math.max(1, Math.min(5, numberSetting(runtime, "X_AUTONOMY_MAX_REPLIES_PER_TICK", X_AUTONOMY_DEFAULT_MAX_REPLIES)));
	const maxDiscoveryPerTick = Math.max(0, Math.min(8, numberSetting(runtime, "X_AUTONOMY_MAX_DISCOVERY_PER_TICK", X_AUTONOMY_DEFAULT_MAX_DISCOVERY)));
	const statusTweetId = asString(metadata.xAutonomyLastStatusTweetId);
	const lastRunAt = readTimestamp(metadata.xAutonomyLastRunAt);
	const lastStatusAt = readTimestamp(metadata.xAutonomyLastStatusAt);
	const lastDiscoveryAt = readTimestamp(metadata.xAutonomyLastDiscoveryAt);
	return {
		available: tasks.some((task) => task.name === X_AUTONOMY_TASK_NAME) || Boolean(runtime.taskWorkers?.has(X_AUTONOMY_TASK_NAME)),
		enabled: booleanSetting(runtime, "X_AUTONOMY_ENABLED", true),
		writeEnabled: booleanSetting(runtime, "X_AUTONOMY_WRITE", true),
		statusPostingEnabled: booleanSetting(runtime, "X_AUTONOMY_POST_STATUS_ENABLED", false),
		discoveryEnabled: booleanSetting(runtime, "X_AUTONOMY_DISCOVERY_ENABLED", true),
		proactiveEngagementEnabled: booleanSetting(runtime, "X_AUTONOMY_PROACTIVE_ENGAGEMENT_ENABLED", false),
		followEnabled: booleanSetting(runtime, "X_AUTONOMY_FOLLOW_ENABLED", false),
		intervalMs,
		statusIntervalMs,
		discoveryIntervalMs,
		maxRepliesPerTick,
		maxDiscoveryPerTick,
		discoveryQueries: listSetting(runtime, "X_AUTONOMY_DISCOVERY_QUERIES", X_AUTONOMY_DEFAULT_DISCOVERY_QUERIES),
		...(lastRunAt !== undefined && { lastRunAt }),
		...(lastStatusAt !== undefined && { lastStatusAt }),
		...(lastDiscoveryAt !== undefined && { lastDiscoveryAt }),
		...(statusTweetId !== undefined && { lastStatusTweetId: statusTweetId }),
		lastHandledCount: lastHandled.length,
		lastHandled,
	};
}

function improvementSnapshot(runtime: RuntimeTaskShape, tasks: ActivityAutonomyTask[], rawTasks: unknown[]): ActivityImprovementSnapshot {
	const hasQueue = (task: unknown): number => {
		const tags = asObject(task).tags;
		return Array.isArray(tags) && tags.map(String).includes("queue") ? 1 : 0;
	};
	const lastImprovementRun = (task: unknown): number =>
		readTimestamp(asObject(asObject(task).metadata).continuousImprovementLastRunAt) ?? 0;
	const candidates = rawTasks
		.filter((task) => asString(asObject(task).name) === CONTINUOUS_IMPROVEMENT_TASK_NAME)
		.sort((a, b) => {
			const at = hasQueue(a);
			const bt = hasQueue(b);
			if (at !== bt) return bt - at;
			return lastImprovementRun(b) - lastImprovementRun(a);
		});
	const rawTask = candidates[0];
	const metadata = asObject(asObject(rawTask).metadata);
	const intervalMs = Math.max(
		5 * 60_000,
		Math.min(24 * 60 * 60_000, numberSetting(runtime, "CONTINUOUS_IMPROVEMENT_INTERVAL_MS", 30 * 60_000)),
	);
	const lastRunAt = readTimestamp(metadata.continuousImprovementLastRunAt);
	const lastMemoryIds = Array.isArray(metadata.continuousImprovementLastMemoryIds)
		? metadata.continuousImprovementLastMemoryIds.map(String)
		: [];
	const lastResult = asString(metadata.continuousImprovementLastResult);
	const lastCategory = asString(metadata.continuousImprovementLastCategory);
	const lastProposal = asString(metadata.continuousImprovementLastProposal);
	const lastError = asString(metadata.continuousImprovementLastError);
	return {
		available:
			tasks.some((task) => task.name === CONTINUOUS_IMPROVEMENT_TASK_NAME) ||
			Boolean(runtime.taskWorkers?.has(CONTINUOUS_IMPROVEMENT_TASK_NAME)),
		enabled: booleanSetting(runtime, "CONTINUOUS_IMPROVEMENT_ENABLED", true),
		intervalMs,
		...(lastRunAt !== undefined && { lastRunAt }),
		...(lastResult !== undefined && { lastResult }),
		...(lastCategory !== undefined && { lastCategory }),
		...(lastProposal !== undefined && { lastProposal }),
		...(lastError !== undefined && { lastError }),
		lastMemoryIds,
	};
}

export class ActivityAutonomyService {
	constructor(private readonly resolveRuntime: () => IAgentRuntime | null) {}

	async snapshot(): Promise<ActivityAutonomySnapshot> {
		const runtime = this.resolveRuntime();
		if (!runtime) return EMPTY;
		const svc = findService(runtime);
		if (!svc?.getStatus) return EMPTY;
		const s = svc.getStatus();
		const r = runtime as unknown as RuntimeTaskShape;
		const workerNames = new Set<string>();
		if (r.taskWorkers) {
			for (const name of r.taskWorkers.keys()) workerNames.add(name);
		}
		let rawTasks: unknown[] = [];
		try {
			rawTasks = (await r.getTasks?.({ tags: [] })) ?? [];
		} catch {
			rawTasks = [];
		}
		const tasks = rawTasks
			.map((item) => normalizeTask(item, workerNames))
			.filter((task): task is ActivityAutonomyTask => !!task && isAutonomyTask(task))
			.sort((a, b) => {
				const an = a.nextRunAt ?? Number.POSITIVE_INFINITY;
				const bn = b.nextRunAt ?? Number.POSITIVE_INFINITY;
				if (an !== bn) return an - bn;
				return a.name.localeCompare(b.name);
			});
		const hasFallbackTask = tasks.some((task) => task.name === "AUTONOMY_THINK" && task.hasWorker);
		const hasPromptBatcher = Boolean(r.promptBatcher);
		const runner = hasPromptBatcher
			? "prompt-batcher"
			: hasFallbackTask
				? "task"
				: s.enabled
					? "missing"
					: "none";
		return {
			available: true,
			enabled: !!s.enabled,
			running: !!s.running,
			thinking: !!s.thinking,
			intervalMs: s.interval ?? 0,
			runner,
			...(s.autonomousRoomId ? { autonomousRoomId: s.autonomousRoomId } : {}),
			tasks,
			x: xSnapshot(r, tasks, rawTasks),
			improvement: improvementSnapshot(r, tasks, rawTasks),
		};
	}

	async setEnabled(enabled: boolean): Promise<boolean> {
		const runtime = this.resolveRuntime();
		if (!runtime) return false;
		const svc = findService(runtime);
		if (!svc) return false;
		if (enabled && svc.enableAutonomy) {
			await svc.enableAutonomy();
			return true;
		}
		if (!enabled && svc.disableAutonomy) {
			await svc.disableAutonomy();
			return true;
		}
		return false;
	}

	async setIntervalMs(ms: number): Promise<boolean> {
		const runtime = this.resolveRuntime();
		if (!runtime) return false;
		const svc = findService(runtime);
		if (!svc?.setLoopInterval) return false;
		await svc.setLoopInterval(Math.max(5_000, Math.min(600_000, Math.round(ms))));
		return true;
	}

	async applyXSettings(update: ActivityXAutonomyUpdate): Promise<boolean> {
		const runtime = this.resolveRuntime() as RuntimeTaskShape | null;
		if (!runtime) return false;
		for (const [key, value] of xAutonomyRuntimeSettings(update)) {
			process.env[key] = value;
			runtime.setSetting?.(key, value);
		}
		await this.syncXTask(runtime);
		return true;
	}

	private async syncXTask(runtime: RuntimeTaskShape): Promise<void> {
		if (!runtime.getTasks || !runtime.createTask) return;
		if (!booleanSetting(runtime, "X_AUTONOMY_ENABLED", true)) return;
		const tasks = await runtime.getTasks({
			...(runtime.agentId ? { agentIds: [runtime.agentId] } : {}),
			tags: ["x-autonomy"],
			limit: 20,
		});
		const primary = tasks.filter(isXTask).sort((a, b) => {
			const aUpdated = asNumber(a.updatedAt) ?? 0;
			const bUpdated = asNumber(b.updatedAt) ?? 0;
			return bUpdated - aUpdated;
		})[0];
		const metadata = xTaskMetadata(primary?.metadata, runtime);
		if (primary?.id) {
			await runtime.updateTask?.(primary.id, {
				description: "Poll X notifications and discover algorithm-fit conversations",
				tags: [...X_AUTONOMY_TASK_TAGS],
				metadata,
			});
			return;
		}
		await runtime.createTask({
			name: X_AUTONOMY_TASK_NAME,
			description: "Poll X notifications and discover algorithm-fit conversations",
			tags: [...X_AUTONOMY_TASK_TAGS],
			metadata,
			dueAt: Date.now() + 15_000,
		});
	}
}
