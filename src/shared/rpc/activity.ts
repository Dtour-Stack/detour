import type {
	ActivityAutonomySnapshot,
	ActivityDbQueryResult,
	ActivityDbTable,
	ActivityDbTableDetail,
	ActivityLogEntry,
	ActivityPluginsSnapshot,
	ActivityRuntimeSnapshot,
	ActivityTasksSnapshot,
	ActivityTrajectoryDetail,
	ActivityTrajectoryExport,
	ActivityTrajectoryListResult,
	ActivityXAutonomyUpdate,
} from "../index";

/**
 * Activity feature group RPC schema. Mirrors the legacy
 * `/api/activity/*` HTTP routes — wire shapes are identical, so
 * call sites swap `client.activity<Foo>(...)` for
 * `rpc.request.activity<Foo>(...)` without further translation.
 *
 * This group has no server-push messages — view→bun traffic only.
 */
export type ActivityRequests = {
	// Logs
	activityLogs: {
		params: {
			level?: string;
			source?: string;
			q?: string;
			limit?: number;
			since?: number;
		};
		response: ActivityLogEntry[];
	};

	// Runtime introspection
	activityRuntime: {
		params: Record<string, never>;
		response: ActivityRuntimeSnapshot;
	};

	// Trajectories
	activityTrajectoriesList: {
		params: {
			limit?: number;
			offset?: number;
			status?: string;
			source?: string;
			q?: string;
		};
		response: ActivityTrajectoryListResult;
	};
	activityTrajectoryGet: {
		params: { id: string };
		response: ActivityTrajectoryDetail;
	};
	activityTrajectoriesExport: {
		params: { ids?: string[] };
		response: ActivityTrajectoryExport;
	};

	// Tasks
	activityTasksList: {
		params: Record<string, never>;
		response: ActivityTasksSnapshot;
	};
	activityTaskRun: {
		params: { id: string };
		response: { ok: true };
	};
	activityTaskPause: {
		params: { id: string };
		response: { ok: true };
	};
	activityTaskResume: {
		params: { id: string };
		response: { ok: true };
	};
	activityTaskDelete: {
		params: { id: string };
		response: { ok: true };
	};

	// Autonomy
	activityAutonomy: {
		params: Record<string, never>;
		response: ActivityAutonomySnapshot;
	};
	activityAutonomySetX: {
		params: { update: ActivityXAutonomyUpdate };
		response: ActivityAutonomySnapshot;
	};
	activityAutonomyEnable: {
		params: Record<string, never>;
		response: { ok: true };
	};
	activityAutonomyDisable: {
		params: Record<string, never>;
		response: { ok: true };
	};
	activityAutonomySetInterval: {
		params: { intervalMs: number };
		response: { ok: true };
	};

	// Plugins
	activityPluginsList: {
		params: Record<string, never>;
		response: ActivityPluginsSnapshot;
	};
	activityPluginsRebuild: {
		params: Record<string, never>;
		response: { ok: boolean; provider: string | null };
	};

	// DB
	activityDbTablesList: {
		params: Record<string, never>;
		response: { available: boolean; tables: ActivityDbTable[] };
	};
	activityDbTableGet: {
		params: { schema: string; name: string };
		response: ActivityDbTableDetail;
	};
	activityDbQuery: {
		params: { sql: string };
		response: ActivityDbQueryResult;
	};
};
