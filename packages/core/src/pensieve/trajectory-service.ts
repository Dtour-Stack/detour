/**
 * Thin wrapper around elizaOS's TrajectoriesService for the
 * Pensieve > Activity > Trajectories pane.
 *
 * The service isn't exported from @elizaos/core's package main — it's only
 * registered on the runtime under `serviceType: "trajectories"`. We resolve
 * via `runtime.getService(...)` and call its methods through duck typing.
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

export interface PensieveTrajectoryDetail {
	trajectory: Record<string, unknown> | null;
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
	getTrajectory?: (id: string) => Promise<Record<string, unknown> | null>;
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
		if (!runtime) return { trajectory: null };
		const svc = findRealService(runtime);
		if (!svc?.getTrajectory) return { trajectory: null };
		const t = await svc.getTrajectory(id);
		return { trajectory: t ?? null };
	}
}
