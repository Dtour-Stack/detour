/**
 * Thin wrapper around elizaOS's TrajectoriesService for the
 * Pensieve > Activity > Trajectories pane.
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

export interface PensieveTrajectoryListItem {
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

export interface PensieveTrajectoryListResult {
	trajectories: PensieveTrajectoryListItem[];
	total: number;
	limit: number;
	offset: number;
}

export interface PensieveLlmCall {
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

export interface PensieveProviderAccess {
	providerId: string;
	providerName: string;
	stepNumber: number;
	timestamp: number;
	purpose?: string;
	query?: unknown;
	data?: unknown;
}

export interface PensieveActionAttempt {
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

export interface PensieveTrajectoryDetail {
	trajectory: PensieveTrajectoryListItem | null;
	totals: {
		stepCount: number;
		llmCallCount: number;
		providerAccessCount: number;
		actionCount: number;
		totalPromptTokens: number;
		totalCompletionTokens: number;
	};
	llmCalls: PensieveLlmCall[];
	providerAccesses: PensieveProviderAccess[];
	actions: PensieveActionAttempt[];
	metadata: Record<string, unknown> | null;
	rewardComponents: Record<string, unknown> | null;
	metrics: Record<string, unknown> | null;
	/** Full untransformed trajectory record — used by the export button. */
	raw: Record<string, unknown> | null;
}

export interface PensieveTrajectoryListOptions {
	limit?: number;
	offset?: number;
	status?: string;
	source?: string;
	q?: string;
}

interface TrajectoriesServiceShape {
	listTrajectories?: (opts: PensieveTrajectoryListOptions) => Promise<{
		trajectories: PensieveTrajectoryListItem[];
		total: number;
		limit?: number;
		offset?: number;
	}>;
	// Real method on TrajectoriesService is `getTrajectoryDetail`, not
	// `getTrajectory` — confirmed against eliza/packages/core/src/features/
	// trajectories/TrajectoriesService.ts:1590.
	getTrajectoryDetail?: (id: string) => Promise<Record<string, unknown> | null>;
	startTrajectory?: unknown;
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

const EMPTY_DETAIL: PensieveTrajectoryDetail = {
	trajectory: null,
	totals: {
		stepCount: 0,
		llmCallCount: 0,
		providerAccessCount: 0,
		actionCount: 0,
		totalPromptTokens: 0,
		totalCompletionTokens: 0,
	},
	llmCalls: [],
	providerAccesses: [],
	actions: [],
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

function flattenDetail(traj: Record<string, unknown>): PensieveTrajectoryDetail {
	const steps = asArray(traj.steps);
	const llmCalls: PensieveLlmCall[] = [];
	const providerAccesses: PensieveProviderAccess[] = [];
	const actions: PensieveActionAttempt[] = [];
	let totalPromptTokens = 0;
	let totalCompletionTokens = 0;

	for (const stepRaw of steps) {
		const step = asObject(stepRaw);
		if (!step) continue;
		const stepNumber = asNumber(step.stepNumber) ?? 0;
		for (const callRaw of asArray(step.llmCalls)) {
			const call = asObject(callRaw);
			if (!call) continue;
			const promptTokens = asNumber(call.promptTokens) ?? 0;
			const completionTokens = asNumber(call.completionTokens) ?? 0;
			totalPromptTokens += promptTokens;
			totalCompletionTokens += completionTokens;
			llmCalls.push({
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
				...(asNumber(call.latencyMs) !== undefined && { latencyMs: asNumber(call.latencyMs)! }),
				...(asString(call.purpose) !== undefined && { purpose: asString(call.purpose)! }),
				...(asString(call.stepType) !== undefined && { stepType: asString(call.stepType)! }),
				...(asString(call.actionType) !== undefined && { actionType: asString(call.actionType)! }),
				...(Array.isArray(call.tags) && { tags: (call.tags as unknown[]).map(String) }),
			});
		}
		for (const accRaw of asArray(step.providerAccesses)) {
			const acc = asObject(accRaw);
			if (!acc) continue;
			providerAccesses.push({
				providerId: asString(acc.providerId) ?? "",
				providerName: asString(acc.providerName) ?? "unknown",
				stepNumber,
				timestamp: asNumber(acc.timestamp) ?? 0,
				...(asString(acc.purpose) !== undefined && { purpose: asString(acc.purpose)! }),
				...(acc.query !== undefined && { query: acc.query }),
				...(acc.data !== undefined && { data: acc.data }),
			});
		}
		const actionRaw = asObject(step.action);
		if (actionRaw) {
			actions.push({
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
			});
		}
	}

	const trajectorySummary: PensieveTrajectoryListItem = {
		id: asString(traj.trajectoryId) ?? asString(traj.id) ?? "",
		...(asString(traj.source) !== undefined && { source: asString(traj.source)! }),
		...(asString((traj.metrics as Record<string, unknown> | undefined)?.finalStatus) !== undefined && {
			status: asString((traj.metrics as Record<string, unknown>).finalStatus)!,
		}),
		...(asNumber(traj.startTime) !== undefined && { startTime: asNumber(traj.startTime)! }),
		...(asNumber(traj.endTime) !== undefined && { endTime: asNumber(traj.endTime)! }),
		...(asNumber(traj.durationMs) !== undefined && { durationMs: asNumber(traj.durationMs)! }),
		llmCallCount: llmCalls.length,
		totalPromptTokens,
		totalCompletionTokens,
	};

	return {
		trajectory: trajectorySummary,
		totals: {
			stepCount: steps.length,
			llmCallCount: llmCalls.length,
			providerAccessCount: providerAccesses.length,
			actionCount: actions.length,
			totalPromptTokens,
			totalCompletionTokens,
		},
		llmCalls,
		providerAccesses,
		actions,
		metadata: asObject(traj.metadata),
		rewardComponents: asObject(traj.rewardComponents),
		metrics: asObject(traj.metrics),
		raw: traj,
	};
}

export class PensieveTrajectoryService {
	constructor(private readonly resolveRuntime: () => IAgentRuntime | null) {}

	async list(opts: PensieveTrajectoryListOptions = {}): Promise<PensieveTrajectoryListResult> {
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

	async get(id: string): Promise<PensieveTrajectoryDetail> {
		const runtime = this.resolveRuntime();
		if (!runtime) return EMPTY_DETAIL;
		const svc = findRealService(runtime);
		if (!svc?.getTrajectoryDetail) return EMPTY_DETAIL;
		const t = await svc.getTrajectoryDetail(id);
		if (!t) return EMPTY_DETAIL;
		return flattenDetail(t);
	}

	/** For the bulk-export button — fetches detail for every trajectory in `ids`. */
	async getMany(ids: string[]): Promise<PensieveTrajectoryDetail[]> {
		const out: PensieveTrajectoryDetail[] = [];
		for (const id of ids) {
			out.push(await this.get(id));
		}
		return out;
	}
}
