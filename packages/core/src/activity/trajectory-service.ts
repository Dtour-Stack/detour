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

import type { IAgentRuntime } from "@elizaos/core";

const SERVICE_TYPE = "trajectories";

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
	metadata: Record<string, unknown> | null;
	rewardComponents: Record<string, unknown> | null;
	metrics: Record<string, unknown> | null;
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
	// Real method on TrajectoriesService is `getTrajectoryDetail`, not
	// `getTrajectory` — confirmed against eliza/packages/core/src/features/
	// trajectories/TrajectoriesService.ts:1590.
	getTrajectoryDetail?: (id: string) => Promise<Record<string, unknown> | null>;
	startTrajectory?: unknown;
	endTrajectory?: (
		id: string,
		status?: "active" | "completed" | "error" | "timeout",
		metrics?: Record<string, unknown>,
	) => Promise<void>;
}

function findRealService(runtime: IAgentRuntime): TrajectoriesServiceShape | null {
	const r = runtime as unknown as {
		getService?: (t: string) => unknown;
		getServicesByType?: (t: string) => unknown[];
	};
	const first = r.getService?.(SERVICE_TYPE);
	if (first && typeof (first as TrajectoriesServiceShape).startTrajectory !== "undefined") {
		return first as TrajectoriesServiceShape;
	}
	const all = r.getServicesByType?.(SERVICE_TYPE) ?? [];
	for (const svc of all) {
		if (svc && typeof (svc as TrajectoriesServiceShape).startTrajectory !== "undefined") {
			return svc as TrajectoriesServiceShape;
		}
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
	metadata: null,
	rewardComponents: null,
	metrics: null,
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

function flattenDetail(traj: Record<string, unknown>): ActivityTrajectoryDetail {
	const steps = asArray(traj.steps);
	const llmCalls: ActivityLlmCall[] = [];
	const providerAccesses: ActivityProviderAccess[] = [];
	const actions: ActivityActionAttempt[] = [];
	const stepSummaries: ActivityTrajectoryStepSummary[] = [];
	let totalPromptTokens = 0;
	let totalCompletionTokens = 0;
	let totalLatencyMs = 0;

	for (const stepRaw of steps) {
		const step = asObject(stepRaw);
		if (!step) continue;
		const stepNumber = asNumber(step.stepNumber) ?? 0;
		const stepCalls: ActivityLlmCall[] = [];
		for (const callRaw of asArray(step.llmCalls)) {
			const call = asObject(callRaw);
			if (!call) continue;
			const promptTokens = asNumber(call.promptTokens) ?? 0;
			const completionTokens = asNumber(call.completionTokens) ?? 0;
			const latencyMs = asNumber(call.latencyMs);
			totalPromptTokens += promptTokens;
			totalCompletionTokens += completionTokens;
			if (typeof latencyMs === "number") totalLatencyMs += latencyMs;
			const normalized: ActivityLlmCall = {
				callId: asString(call.callId) ?? `${stepNumber}-${llmCalls.length}`,
				stepNumber,
				timestamp: asNumber(call.timestamp) ?? 0,
				model: asString(call.model) ?? "?",
				...(asString(call.systemPrompt) !== undefined && { systemPrompt: asString(call.systemPrompt)! }),
				...(asString(call.userPrompt) !== undefined && { userPrompt: asString(call.userPrompt)! }),
				...(asString(call.response) !== undefined && { response: asString(call.response)! }),
				...(asString(call.reasoning) !== undefined && { reasoning: asString(call.reasoning)! }),
				...(asNumber(call.temperature) !== undefined && { temperature: asNumber(call.temperature)! }),
				...(asNumber(call.maxTokens) !== undefined && { maxTokens: asNumber(call.maxTokens)! }),
				promptTokens,
				completionTokens,
				...(latencyMs !== undefined && { latencyMs }),
				...(asString(call.purpose) !== undefined && { purpose: asString(call.purpose)! }),
				...(asString(call.stepType) !== undefined && { stepType: asString(call.stepType)! }),
				...(asString(call.actionType) !== undefined && { actionType: asString(call.actionType)! }),
				...(Array.isArray(call.tags) && { tags: (call.tags as unknown[]).map(String) }),
			};
			llmCalls.push(normalized);
			stepCalls.push(normalized);
		}
		const stepProviders: ActivityProviderAccess[] = [];
		for (const accRaw of asArray(step.providerAccesses)) {
			const acc = asObject(accRaw);
			if (!acc) continue;
			const normalized: ActivityProviderAccess = {
				providerId: asString(acc.providerId) ?? "",
				providerName: asString(acc.providerName) ?? "unknown",
				stepNumber,
				timestamp: asNumber(acc.timestamp) ?? 0,
				...(asString(acc.purpose) !== undefined && { purpose: asString(acc.purpose)! }),
				...(acc.query !== undefined && { query: acc.query }),
				...(acc.data !== undefined && { data: acc.data }),
			};
			providerAccesses.push(normalized);
			stepProviders.push(normalized);
		}
		const actionRaw = asObject(step.action);
		let stepAction: ActivityActionAttempt | null = null;
		if (actionRaw && Object.keys(actionRaw).length > 0) {
			stepAction = {
				attemptId: asString(actionRaw.attemptId) ?? `${stepNumber}-action`,
				stepNumber,
				timestamp: asNumber(actionRaw.timestamp) ?? 0,
				...(asString(actionRaw.actionType) !== undefined && { actionType: asString(actionRaw.actionType)! }),
				...(asString(actionRaw.actionName) !== undefined && { actionName: asString(actionRaw.actionName)! }),
				...(actionRaw.parameters !== undefined && { parameters: actionRaw.parameters }),
				...(asString(actionRaw.reasoning) !== undefined && { reasoning: asString(actionRaw.reasoning)! }),
				...(asBoolean(actionRaw.success) !== undefined && { success: asBoolean(actionRaw.success)! }),
				...(actionRaw.result !== undefined && { result: actionRaw.result }),
				...(asString(actionRaw.error) !== undefined && { error: asString(actionRaw.error)! }),
				...(asNumber(actionRaw.immediateReward) !== undefined && { immediateReward: asNumber(actionRaw.immediateReward)! }),
			};
			actions.push(stepAction);
		}
		const stepEnv = asObject(step.environmentState);
		const stepMeta = asObject(step.metadata);
		stepSummaries.push({
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
		});
	}

	const meta = asObject(traj.metadata);
	const metrics = asObject(traj.metrics);
	const status = asString(metrics?.finalStatus);
	const trajId = asString(traj.trajectoryId) ?? asString(traj.id) ?? "";

	const trajectorySummary: ActivityTrajectoryListItem = {
		id: trajId,
		...(asString(traj.source) !== undefined && { source: asString(traj.source)! }),
		...(status !== undefined && { status }),
		...(asNumber(traj.startTime) !== undefined && { startTime: asNumber(traj.startTime)! }),
		...(asNumber(traj.endTime) !== undefined && { endTime: asNumber(traj.endTime)! }),
		...(asNumber(traj.durationMs) !== undefined && { durationMs: asNumber(traj.durationMs)! }),
		llmCallCount: llmCalls.length,
		totalPromptTokens,
		totalCompletionTokens,
	};

	const identity: ActivityTrajectoryIdentity = {
		id: trajId,
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

	return {
		trajectory: trajectorySummary,
		identity,
		totals: {
			stepCount: steps.length,
			llmCallCount: llmCalls.length,
			providerAccessCount: providerAccesses.length,
			actionCount: actions.length,
			totalPromptTokens,
			totalCompletionTokens,
			totalLatencyMs,
		},
		llmCalls,
		providerAccesses,
		actions,
		steps: stepSummaries,
		metadata: meta && Object.keys(meta).length > 0 ? meta : null,
		rewardComponents: asObject(traj.rewardComponents),
		metrics: metrics && Object.keys(metrics).length > 0 ? metrics : null,
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
		const out: ActivityTrajectoryDetail[] = [];
		for (const id of ids) {
			out.push(await this.get(id));
		}
		return out;
	}
}
