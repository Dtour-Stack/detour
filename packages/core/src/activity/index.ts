/**
 * Activity composition root.
 *
 * Activity = operational/runtime observability: logs, trajectories, registered
 * tasks, and runtime introspection. None of this belongs in Pensieve, which is
 * the *knowledge* surface (memories, relationships, templates, graph).
 *
 * Exposed under `/api/activity/*`.
 */

import type { IAgentRuntime } from "@elizaos/core";
import type { RuntimeService } from "../runtime";
import { ActivityAutonomyService } from "./autonomy-service";
import { ActivityDbService } from "./db-service";
import { ActivityLogService } from "./log-service";
import { ActivityTrajectoryService } from "./trajectory-service";
import { ActivityTasksService } from "./tasks-service";
import {
	snapshotPlugins,
	snapshotRuntime,
	type ActivityPluginsSnapshot,
	type ActivityRuntimeSnapshot,
} from "./runtime-introspect";

export class ActivityService {
	readonly logs: ActivityLogService;
	readonly trajectories: ActivityTrajectoryService;
	readonly tasks: ActivityTasksService;
	readonly autonomy: ActivityAutonomyService;
	readonly db: ActivityDbService;

	constructor(private readonly runtimeService: RuntimeService) {
		const resolve = (): IAgentRuntime | null => this.runtimeService.peek();
		this.logs = new ActivityLogService();
		this.trajectories = new ActivityTrajectoryService(resolve);
		this.tasks = new ActivityTasksService(resolve);
		this.autonomy = new ActivityAutonomyService(resolve);
		this.db = new ActivityDbService(resolve);
	}

	start(): void {
		this.logs.start();
	}

	stop(): void {
		this.logs.stop();
	}

	runtimeSnapshot(): ActivityRuntimeSnapshot {
		return snapshotRuntime(this.runtimeService.peek());
	}

	pluginsSnapshot(): ActivityPluginsSnapshot {
		return snapshotPlugins(this.runtimeService.peek());
	}
}

export type { ActivityLogEntry, ListLogsOptions } from "./log-service";
export type {
	ActivityTrajectoryListItem,
	ActivityTrajectoryListResult,
	ActivityTrajectoryDetail,
	ActivityTrajectoryListOptions,
	ActivityTrajectoryStepSummary,
	ActivityTrajectoryIdentity,
	ActivityLlmCall,
	ActivityProviderAccess,
	ActivityActionAttempt,
} from "./trajectory-service";
export type {
	ActivityTaskWorker,
	ActivityTaskRecord,
	ActivityTasksSnapshot,
} from "./tasks-service";
export type {
	ActivityRuntimeSnapshot,
	RuntimeRegistryItem,
	ActivityPluginsSnapshot,
	ActivityPluginDetail,
} from "./runtime-introspect";
export type { ActivityAutonomySnapshot } from "./autonomy-service";
export type { DbColumn, DbTable, DbTableDetail, DbQueryResult } from "./db-service";
