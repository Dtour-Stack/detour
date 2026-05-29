/**
 * Thin wrapper around elizaOS's TrajectoriesService for the
 * Activity > Trajectories pane.
 *
 * The service isn't exported from @elizaos/core's package main — it's only
 * registered on the runtime under `serviceType: "trajectories"`. We resolve
 * via `runtime.getService(...)` and call its methods through duck typing.
 *
 * `get()` returns a flattened detail shape (top-level llmCalls, providerAccesses,
 * actions arrays computed by walking the steps[]) so the UI doesn't have to
 * re-implement the same flatten on every render.
 */

import { sql } from "drizzle-orm";
import type { IAgentRuntime } from "@elizaos/core";

const SERVICE_TYPE = "trajectories";

/** Raw-SQL escape hatch, same path ActivityDbService uses. */
interface AdapterDb {
	execute(query: ReturnType<typeof sql.raw>): Promise<{ rows?: Record<string, unknown>[] }>;
}
function getAdapterDb(runtime: IAgentRuntime): AdapterDb | null {
	const r = runtime as unknown as { adapter?: { db?: unknown } };
	const db = r.adapter?.db;
	if (!db || typeof (db as AdapterDb).execute !== "function") return null;
	return db as AdapterDb;
}

export interface ActivityTrajectoryListItem {
	id: string;
	source?: string;
	status?: string;
	startTime?: number;
	endTime?: number;
	durationMs?: number;
	llmCallCount?: number;
	totalPromptTokens?: number;
	totalCompletionTokens?: number;
}

export interface ActivityTrajectoryListResult {
	trajectories: ActivityTrajectoryListItem[];
	total: number;
	limit: number;
	offset: number;
}

export interface ActivityLlmCall {
	callId: string;
	stepNumber: number;
	timestamp: number;
	model: string;
	systemPrompt?: string;
	userPrompt?: string;
	response?: string;
	reasoning?: string;
	temperature?: number;
	maxTokens?: number;
	promptTokens?: number;
	completionTokens?: number;
	latencyMs?: number;
	purpose?: string;
	stepType?: string;
	actionType?: string;
	tags?: string[];
}

export interface ActivityProviderAccess {
	providerId: string;
	providerName: string;
	stepNumber: number;
	timestamp: number;
	purpose?: string;
	query?: unknown;
	data?: unknown;
}

export interface ActivityActionAttempt {
	attemptId: string;
	stepNumber: number;
	timestamp: number;
	actionType?: string;
	actionName?: string;
	parameters?: unknown;
	reasoning?: string;
	success?: boolean;
	result?: unknown;
	error?: string;
	immediateReward?: number;
}

export interface ActivityTrajectoryStepSummary {
	stepNumber: number;
	timestamp: number;
	reasoning?: string;
	reward?: number;
	done?: boolean;
	llmCallCount: number;
	providerAccessCount: number;
	hasAction: boolean;
	actionName?: string;
	actionSuccess?: boolean;
	observation?: unknown;
	environmentState?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
}

export interface ActivityTrajectoryIdentity {
	id: string;
	agentId?: string;
	agentName?: string;
	agentModel?: string;
	episodeId?: string;
	scenarioId?: string;
	batchId?: string;
	groupIndex?: number;
	source?: string;
	status?: string;
	startTime?: number;
	endTime?: number;
	durationMs?: number;
	totalReward?: number;
}

export interface ActivityTrajectoryDetail {
	trajectory: ActivityTrajectoryListItem | null;
	identity: ActivityTrajectoryIdentity | null;
	totals: {
		stepCount: number;
		llmCallCount: number;
		providerAccessCount: number;
		actionCount: number;
		totalPromptTokens: number;
		totalCompletionTokens: number;
		totalLatencyMs: number;
	};
	llmCalls: ActivityLlmCall[];
	providerAccesses: ActivityProviderAccess[];
	actions: ActivityActionAttempt[];
	steps: ActivityTrajectoryStepSummary[];
	metadata: Record<string, unknown>;
	rewardComponents: Record<string, unknown> | null;
	metrics: Record<string, unknown>;
	/** Full untransformed trajectory record — used by the export button. */
	raw: Record<string, unknown> | null;
}

export interface ActivityTrajectoryListOptions {
	limit?: number;
	offset?: number;
	status?: string;
	source?: string;
	q?: string;
}

interface TrajectoriesServiceShape {
	listTrajectories?: (opts: ActivityTrajectoryListOptions) => Promise<{
		trajectories: ActivityTrajectoryListItem[];
		total: number;
		limit?: number;
		offset?: number;
	}>;
	getTrajectoryDetail?: (id: string) => Promise<Record<string, unknown> | null>;
	endTrajectory?: (
		id: string,
		status?: "active" | "completed" | "error" | "timeout",
		metrics?: Record<string, unknown>,
	) => Promise<void>;
}

function isTrajectoriesService(value: unknown): value is TrajectoriesServiceShape {
	if (!value || typeof value !== "object") return false;
	const svc = value as TrajectoriesServiceShape;
	return typeof svc.getTrajectoryDetail === "function"
		|| typeof svc.listTrajectories === "function"
		|| typeof svc.endTrajectory === "function";
}

function findRealService(runtime: IAgentRuntime): TrajectoriesServiceShape | null {
	const r = runtime as unknown as {
		getService?: (t: string) => unknown;
		getServicesByType?: (t: string) => unknown[];
	};
	const first = r.getService?.(SERVICE_TYPE);
	if (isTrajectoriesService(first)) return first;
	const all = r.getServicesByType?.(SERVICE_TYPE) ?? [];
	for (const svc of all) {
		if (isTrajectoriesService(svc)) return svc;
	}
	return null;
}

const EMPTY_DETAIL: ActivityTrajectoryDetail = {
	trajectory: null,
	identity: null,
	totals: {
		stepCount: 0,
		llmCallCount: 0,
		providerAccessCount: 0,
		actionCount: 0,
		totalPromptTokens: 0,
		totalCompletionTokens: 0,
		totalLatencyMs: 0,
	},
	llmCalls: [],
	providerAccesses: [],
	actions: [],
	steps: [],
	metadata: {},
	rewardComponents: null,
	metrics: {},
	raw: null,
};

function asObject(v: unknown): Record<string, unknown> | null {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function asArray(v: unknown): unknown[] {
	return Array.isArray(v) ? v : [];
}
function asString(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function asBoolean(v: unknown): boolean | undefined {
	return typeof v === "boolean" ? v : undefined;
}

type FlattenAccumulator = {
	llmCalls: ActivityLlmCall[];
	providerAccesses: ActivityProviderAccess[];
	actions: ActivityActionAttempt[];
	steps: ActivityTrajectoryStepSummary[];
	totalPromptTokens: number;
	totalCompletionTokens: number;
	totalLatencyMs: number;
};

function flattenAccumulator(): FlattenAccumulator {
	return {
		llmCalls: [],
		providerAccesses: [],
		actions: [],
		steps: [],
		totalPromptTokens: 0,
		totalCompletionTokens: 0,
		totalLatencyMs: 0,
	};
}

const LLM_STRING_FIELDS = [
	"systemPrompt",
	"userPrompt",
	"response",
	"reasoning",
	"purpose",
	"stepType",
	"actionType",
] as const;

const LLM_NUMBER_FIELDS = ["temperature", "maxTokens"] as const;

function llmStringFields(call: Record<string, unknown>): Partial<ActivityLlmCall> {
	const fields: Partial<ActivityLlmCall> = {};
	for (const key of LLM_STRING_FIELDS) {
		const value = asString(call[key]);
		if (value !== undefined) fields[key] = value;
	}
	return fields;
}

function llmNumberFields(call: Record<string, unknown>): Partial<ActivityLlmCall> {
	const fields: Partial<ActivityLlmCall> = {};
	for (const key of LLM_NUMBER_FIELDS) {
		const value = asNumber(call[key]);
		if (value !== undefined) fields[key] = value;
	}
	return fields;
}

function llmTags(call: Record<string, unknown>): Partial<ActivityLlmCall> {
	return Array.isArray(call.tags) ? { tags: call.tags.map(String) } : {};
}

function fallbackLlmCallId(call: Record<string, unknown>, stepNumber: number, fallbackIndex: number): string {
	const timestamp = asNumber(call.timestamp) ?? 0;
	const model = (asString(call.model) ?? "unknown").replace(/[^\w.-]+/g, "_");
	return `${stepNumber}-${fallbackIndex}-${timestamp}-${model}`;
}

function normalizeLlmCall(
	call: Record<string, unknown>,
	stepNumber: number,
	fallbackIndex: number,
): { call: ActivityLlmCall; promptTokens: number; completionTokens: number; latencyMs?: number } {
	const promptTokens = asNumber(call.promptTokens) ?? 0;
	const completionTokens = asNumber(call.completionTokens) ?? 0;
	const latencyMs = asNumber(call.latencyMs);
	return {
		promptTokens,
		completionTokens,
		...(latencyMs !== undefined ? { latencyMs } : {}),
		call: {
			callId: asString(call.callId) ?? fallbackLlmCallId(call, stepNumber, fallbackIndex),
			stepNumber,
			timestamp: asNumber(call.timestamp) ?? 0,
			model: asString(call.model) ?? "?",
			...llmStringFields(call),
			...llmNumberFields(call),
			promptTokens,
			completionTokens,
			...(latencyMs !== undefined && { latencyMs }),
			...llmTags(call),
		},
	};
}

function collectLlmCalls(step: Record<string, unknown>, stepNumber: number, acc: FlattenAccumulator): ActivityLlmCall[] {
	const stepCalls: ActivityLlmCall[] = [];
	for (const callRaw of asArray(step.llmCalls)) {
		const call = asObject(callRaw);
		if (!call) continue;
		const normalized = normalizeLlmCall(call, stepNumber, acc.llmCalls.length);
		acc.totalPromptTokens += normalized.promptTokens;
		acc.totalCompletionTokens += normalized.completionTokens;
		if (normalized.latencyMs !== undefined) acc.totalLatencyMs += normalized.latencyMs;
		acc.llmCalls.push(normalized.call);
		stepCalls.push(normalized.call);
	}
	return stepCalls;
}

function normalizeProviderAccess(acc: Record<string, unknown>, stepNumber: number): ActivityProviderAccess {
	return {
		providerId: asString(acc.providerId) ?? "",
		providerName: asString(acc.providerName) ?? "unknown",
		stepNumber,
		timestamp: asNumber(acc.timestamp) ?? 0,
		...(asString(acc.purpose) !== undefined && { purpose: asString(acc.purpose)! }),
		...(acc.query !== undefined && { query: acc.query }),
		...(acc.data !== undefined && { data: acc.data }),
	};
}

function collectProviderAccesses(step: Record<string, unknown>, stepNumber: number, acc: FlattenAccumulator): ActivityProviderAccess[] {
	const stepProviders: ActivityProviderAccess[] = [];
	for (const accRaw of asArray(step.providerAccesses)) {
		const provider = asObject(accRaw);
		if (!provider) continue;
		const normalized = normalizeProviderAccess(provider, stepNumber);
		acc.providerAccesses.push(normalized);
		stepProviders.push(normalized);
	}
	return stepProviders;
}

function normalizeActionAttempt(action: Record<string, unknown>, stepNumber: number): ActivityActionAttempt {
	return {
		attemptId: asString(action.attemptId) ?? `${stepNumber}-action`,
		stepNumber,
		timestamp: asNumber(action.timestamp) ?? 0,
		...(asString(action.actionType) !== undefined && { actionType: asString(action.actionType)! }),
		...(asString(action.actionName) !== undefined && { actionName: asString(action.actionName)! }),
		...(action.parameters !== undefined && { parameters: action.parameters }),
		...(asString(action.reasoning) !== undefined && { reasoning: asString(action.reasoning)! }),
		...(asBoolean(action.success) !== undefined && { success: asBoolean(action.success)! }),
		...(action.result !== undefined && { result: action.result }),
		...(asString(action.error) !== undefined && { error: asString(action.error)! }),
		...(asNumber(action.immediateReward) !== undefined && { immediateReward: asNumber(action.immediateReward)! }),
	};
}

function collectAction(step: Record<string, unknown>, stepNumber: number, acc: FlattenAccumulator): ActivityActionAttempt | null {
	const actionRaw = asObject(step.action);
	if (!actionRaw || Object.keys(actionRaw).length === 0) return null;
	const action = normalizeActionAttempt(actionRaw, stepNumber);
	acc.actions.push(action);
	return action;
}

function stepSummary(
	step: Record<string, unknown>,
	stepNumber: number,
	stepCalls: ActivityLlmCall[],
	stepProviders: ActivityProviderAccess[],
	stepAction: ActivityActionAttempt | null,
): ActivityTrajectoryStepSummary {
	const stepEnv = asObject(step.environmentState);
	const stepMeta = asObject(step.metadata);
	return {
		stepNumber,
		timestamp: asNumber(step.timestamp) ?? 0,
		...(asString(step.reasoning) !== undefined && { reasoning: asString(step.reasoning)! }),
		...(asNumber(step.reward) !== undefined && { reward: asNumber(step.reward)! }),
		...(asBoolean(step.done) !== undefined && { done: asBoolean(step.done)! }),
		llmCallCount: stepCalls.length,
		providerAccessCount: stepProviders.length,
		hasAction: !!stepAction,
		...(stepAction?.actionName !== undefined && { actionName: stepAction.actionName }),
		...(stepAction?.success !== undefined && { actionSuccess: stepAction.success }),
		...(step.observation !== undefined && { observation: step.observation }),
		...(stepEnv && Object.keys(stepEnv).length > 0 && { environmentState: stepEnv }),
		...(stepMeta && Object.keys(stepMeta).length > 0 && { metadata: stepMeta }),
	};
}

function collectStep(stepRaw: unknown, acc: FlattenAccumulator): void {
	const step = asObject(stepRaw);
	if (!step) return;
	const stepNumber = asNumber(step.stepNumber) ?? 0;
	const stepCalls = collectLlmCalls(step, stepNumber, acc);
	const stepProviders = collectProviderAccesses(step, stepNumber, acc);
	const stepAction = collectAction(step, stepNumber, acc);
	acc.steps.push(stepSummary(step, stepNumber, stepCalls, stepProviders, stepAction));
}

function trajectoryStatus(traj: Record<string, unknown>): string | undefined {
	return asString(asObject(traj.metrics)?.finalStatus);
}

function trajectorySummary(traj: Record<string, unknown>, acc: FlattenAccumulator, status: string | undefined): ActivityTrajectoryListItem {
	const id = asString(traj.trajectoryId) ?? asString(traj.id) ?? "";
	return {
		id,
		...(asString(traj.source) !== undefined && { source: asString(traj.source)! }),
		...(status !== undefined && { status }),
		...(asNumber(traj.startTime) !== undefined && { startTime: asNumber(traj.startTime)! }),
		...(asNumber(traj.endTime) !== undefined && { endTime: asNumber(traj.endTime)! }),
		...(asNumber(traj.durationMs) !== undefined && { durationMs: asNumber(traj.durationMs)! }),
		llmCallCount: acc.llmCalls.length,
		totalPromptTokens: acc.totalPromptTokens,
		totalCompletionTokens: acc.totalCompletionTokens,
	};
}

function trajectoryIdentity(traj: Record<string, unknown>, meta: Record<string, unknown> | null, status: string | undefined): ActivityTrajectoryIdentity {
	const id = asString(traj.trajectoryId) ?? asString(traj.id) ?? "";
	return {
		id,
		...(asString(traj.agentId) !== undefined && { agentId: asString(traj.agentId)! }),
		...(asString(meta?.agentName) !== undefined && { agentName: asString(meta?.agentName)! }),
		...(asString(meta?.agentModel) !== undefined && { agentModel: asString(meta?.agentModel)! }),
		...(asString(traj.episodeId) !== undefined && { episodeId: asString(traj.episodeId)! }),
		...(asString(traj.scenarioId) !== undefined && { scenarioId: asString(traj.scenarioId)! }),
		...(asString(traj.batchId) !== undefined && { batchId: asString(traj.batchId)! }),
		...(asNumber(traj.groupIndex) !== undefined && { groupIndex: asNumber(traj.groupIndex)! }),
		...(asString(traj.source) !== undefined && { source: asString(traj.source)! }),
		...(status !== undefined && { status }),
		...(asNumber(traj.startTime) !== undefined && { startTime: asNumber(traj.startTime)! }),
		...(asNumber(traj.endTime) !== undefined && { endTime: asNumber(traj.endTime)! }),
		...(asNumber(traj.durationMs) !== undefined && { durationMs: asNumber(traj.durationMs)! }),
		...(asNumber(traj.totalReward) !== undefined && { totalReward: asNumber(traj.totalReward)! }),
	};
}

function flattenDetail(traj: Record<string, unknown>): ActivityTrajectoryDetail {
	const steps = asArray(traj.steps);
	const acc = flattenAccumulator();

	for (const stepRaw of steps) collectStep(stepRaw, acc);

	const meta = asObject(traj.metadata);
	const metrics = asObject(traj.metrics);
	const status = trajectoryStatus(traj);

	return {
		trajectory: trajectorySummary(traj, acc, status),
		identity: trajectoryIdentity(traj, meta, status),
		totals: {
			stepCount: steps.length,
			llmCallCount: acc.llmCalls.length,
			providerAccessCount: acc.providerAccesses.length,
			actionCount: acc.actions.length,
			totalPromptTokens: acc.totalPromptTokens,
			totalCompletionTokens: acc.totalCompletionTokens,
			totalLatencyMs: acc.totalLatencyMs,
		},
		llmCalls: acc.llmCalls,
		providerAccesses: acc.providerAccesses,
		actions: acc.actions,
		steps: acc.steps,
		metadata: meta ?? {},
		rewardComponents: asObject(traj.rewardComponents),
		metrics: metrics ?? {},
		raw: traj,
	};
}

export class ActivityTrajectoryService {
	constructor(private readonly resolveRuntime: () => IAgentRuntime | null) {}

	async list(opts: ActivityTrajectoryListOptions = {}): Promise<ActivityTrajectoryListResult> {
		const runtime = this.resolveRuntime();
		const limit = opts.limit ?? 50;
		const offset = opts.offset ?? 0;
		if (!runtime) return { trajectories: [], total: 0, limit, offset };
		const svc = findRealService(runtime);
		if (!svc?.listTrajectories) return { trajectories: [], total: 0, limit, offset };
		const result = await svc.listTrajectories(opts);
		return {
			trajectories: result.trajectories,
			total: result.total,
			limit: result.limit ?? limit,
			offset: result.offset ?? offset,
		};
	}

	async get(id: string): Promise<ActivityTrajectoryDetail> {
		const runtime = this.resolveRuntime();
		if (!runtime) return EMPTY_DETAIL;
		const svc = findRealService(runtime);
		if (!svc?.getTrajectoryDetail) return EMPTY_DETAIL;
		const t = await svc.getTrajectoryDetail(id);
		if (!t) return EMPTY_DETAIL;
		return flattenDetail(t);
	}

	/**
	 * Sweep stale active trajectories. Eliza creates trajectories on every
	 * inbound message but doesn't always close them when shouldRespond
	 * returns IGNORE — so trajectories stay "active" forever, accumulating
	 * memory and lying about runtime state. This closes any trajectory still
	 * "active" after `olderThanMs` since startTime, marking them "timeout".
	 *
	 * Returns the number closed. Safe to call repeatedly.
	 */
	async sweepStale(olderThanMs = 5 * 60_000): Promise<{ closed: number; checked: number }> {
		const runtime = this.resolveRuntime();
		if (!runtime) return { closed: 0, checked: 0 };
		const svc = findRealService(runtime);
		if (!svc?.listTrajectories || !svc.endTrajectory) return { closed: 0, checked: 0 };
		const now = Date.now();
		const result = await svc.listTrajectories({ status: "active", limit: 500 });
		let closed = 0;
		for (const t of result.trajectories) {
			const age = now - (t.startTime ?? now);
			if (age >= olderThanMs) {
				try {
					await svc.endTrajectory(t.id, "timeout");
					closed++;
				} catch {
					// best-effort — skip rows that can't be closed
				}
			}
		}
		return { closed, checked: result.trajectories.length };
	}

	/** For the bulk-export button — fetches detail for every trajectory in `ids`. */
	async getMany(ids: string[]): Promise<ActivityTrajectoryDetail[]> {
		return Promise.all(ids.map((id) => this.get(id)));
	}

	/**
	 * Retention prune: keep only the newest `retentionCount` trajectories (by
	 * created_at), deleting the rest plus their `trajectory_step_index` rows,
	 * then VACUUM to free space. Trajectories are full LLM dumps and dominate DB
	 * size; callers archive them off-machine (HF) BEFORE pruning. Plain VACUUM
	 * reclaims space for reuse (keeping the DB bounded); a one-off VACUUM FULL
	 * is what shrinks the file on disk. Best-effort: returns 0s if the DB
	 * adapter or tables are unavailable.
	 */
	async prune(retentionCount: number): Promise<{ trajectoriesDeleted: number; vacuumed: boolean }> {
		const runtime = this.resolveRuntime();
		if (!runtime) return { trajectoriesDeleted: 0, vacuumed: false };
		const db = getAdapterDb(runtime);
		if (!db) return { trajectoriesDeleted: 0, vacuumed: false };
		const keep = Math.max(0, Math.floor(retentionCount));
		try {
			const before = await db.execute(sql.raw(`SELECT count(*)::int AS c FROM trajectories`));
			const total = Number((before.rows?.[0] as { c?: number } | undefined)?.c ?? 0);
			const toDelete = Math.max(0, total - keep);
			if (toDelete === 0) return { trajectoriesDeleted: 0, vacuumed: false };
			// Step-index rows first (FK child), then the trajectories themselves.
			await db.execute(sql.raw(
				`WITH keep AS (SELECT id FROM trajectories ORDER BY created_at DESC LIMIT ${keep}) ` +
				`DELETE FROM trajectory_step_index WHERE trajectory_id NOT IN (SELECT id FROM keep)`,
			));
			await db.execute(sql.raw(
				`WITH keep AS (SELECT id FROM trajectories ORDER BY created_at DESC LIMIT ${keep}) ` +
				`DELETE FROM trajectories WHERE id NOT IN (SELECT id FROM keep)`,
			));
			let vacuumed = false;
			try { await db.execute(sql.raw("VACUUM")); vacuumed = true; } catch { /* adapter may forbid VACUUM in a tx — deletes still free space for reuse */ }
			return { trajectoriesDeleted: toDelete, vacuumed };
		} catch {
			return { trajectoriesDeleted: 0, vacuumed: false };
		}
	}

	/**
	 * Recent completed trajectories not yet learned from — the input to the
	 * Phase 2 distiller. Carries the reward signal so the distiller can sort
	 * wins (high reward) from misfires (low/negative reward).
	 */
	async listForLearning(limit = 40): Promise<TrajectoryLearningRow[]> {
		const runtime = this.resolveRuntime();
		if (!runtime) return [];
		const db = getAdapterDb(runtime);
		if (!db) return [];
		try {
			const res = await db.execute(sql.raw(
				`SELECT id, source, status, total_reward, ai_judge_reward, ai_judge_reasoning, step_count, llm_call_count ` +
				`FROM trajectories WHERE (used_in_training IS NOT TRUE) AND status <> 'active' ` +
				`ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(500, Math.floor(limit)))}`,
			));
			return (res.rows ?? []).map((r) => ({
				id: String(r.id ?? ""),
				source: String(r.source ?? ""),
				status: String(r.status ?? ""),
				totalReward: Number(r.total_reward ?? 0),
				aiJudgeReward: r.ai_judge_reward == null ? null : Number(r.ai_judge_reward),
				aiJudgeReasoning: typeof r.ai_judge_reasoning === "string" ? r.ai_judge_reasoning : null,
				stepCount: Number(r.step_count ?? 0),
				llmCallCount: Number(r.llm_call_count ?? 0),
			})).filter((t) => t.id);
		} catch {
			return [];
		}
	}

	/**
	 * Mark trajectories as learned-from: sets `used_in_training`, so the Phase 2
	 * distiller won't reprocess them and Phase 1 retention may prune them.
	 * Returns the number marked. IDs are validated as UUIDs before interpolation.
	 */
	async markLearned(ids: string[]): Promise<number> {
		const runtime = this.resolveRuntime();
		if (!runtime) return 0;
		const db = getAdapterDb(runtime);
		if (!db) return 0;
		const safe = ids.filter((id) => /^[0-9a-fA-F-]{36}$/.test(id));
		if (safe.length === 0) return 0;
		try {
			const list = safe.map((id) => `'${id}'`).join(",");
			await db.execute(sql.raw(`UPDATE trajectories SET used_in_training = TRUE WHERE id IN (${list})`));
			return safe.length;
		} catch {
			return 0;
		}
	}
}

export interface TrajectoryLearningRow {
	id: string;
	source: string;
	status: string;
	totalReward: number;
	aiJudgeReward: number | null;
	aiJudgeReasoning: string | null;
	stepCount: number;
	llmCallCount: number;
}
