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
} from "../../../../shared/index";
import { X_AUTONOMY_LIMITS, X_AUTONOMY_NUMBER_FIELDS } from "../../../../shared/x-autonomy-policy";
import { xAutonomyRuntimeSettings } from "../../activity/autonomy-service";
import { pensieveAudit } from "../../pensieve";
import type { RpcDeps } from "../types";

/**
 * Activity feature group handlers. Wire shapes mirror the legacy
 * `/api/activity/*` HTTP routes (see src/bun/core/api/server.ts) so
 * call sites can move 1:1.
 *
 * X autonomy validation uses the shared autonomy policy so UI writes,
 * runtime snapshots, and task workers clamp the same fields the same way.
 */

type XAutonomyBooleanField =
	| "enabled"
	| "writeEnabled"
	| "statusPostingEnabled"
	| "discoveryEnabled"
	| "proactiveEngagementEnabled"
	| "followEnabled";

const X_AUTONOMY_BOOLEAN_FIELDS: XAutonomyBooleanField[] = [
	"enabled",
	"writeEnabled",
	"statusPostingEnabled",
	"discoveryEnabled",
	"proactiveEngagementEnabled",
	"followEnabled",
];

function recordValue(body: unknown): Record<string, unknown> | null {
	if (body && typeof body === "object" && !Array.isArray(body)) {
		return body as Record<string, unknown>;
	}
	return null;
}

function validateXAutonomyUpdate(update: ActivityXAutonomyUpdate): {
	ok: true;
	value: ActivityXAutonomyUpdate;
} | { ok: false; error: string } {
	const bag = recordValue(update);
	if (!bag) return { ok: false, error: "update must be an object" };
	const out: Record<string, unknown> = {};
	for (const key of X_AUTONOMY_BOOLEAN_FIELDS) {
		const value = bag[key];
		if (value === undefined) continue;
		if (typeof value !== "boolean") return { ok: false, error: `${key} must be boolean` };
		out[key] = value;
	}
	for (const field of X_AUTONOMY_NUMBER_FIELDS) {
		const value = bag[field.key];
		if (value === undefined) continue;
		if (typeof value !== "number" || !Number.isFinite(value)) {
			return { ok: false, error: `${field.key} must be a finite number` };
		}
		out[field.key] = Math.max(field.min, Math.min(field.max, Math.round(value)));
	}
	if (bag.discoveryQueries !== undefined) {
		if (!Array.isArray(bag.discoveryQueries)) {
			return { ok: false, error: "discoveryQueries must be an array of strings" };
		}
		const queries: string[] = [];
		for (const item of bag.discoveryQueries) {
			if (typeof item !== "string") {
				return { ok: false, error: "discoveryQueries must be an array of strings" };
			}
			const query = item.trim();
			if (query.length > 0) queries.push(query);
		}
		out.discoveryQueries = queries.slice(0, X_AUTONOMY_LIMITS.discoveryQueries.max);
	}
	return { ok: true, value: out as ActivityXAutonomyUpdate };
}

export function activityRequests(deps: RpcDeps) {
	return {
		// --- Logs ---
		activityLogs: async (params: {
			level?: string;
			source?: string;
			q?: string;
			limit?: number;
			since?: number;
		}): Promise<ActivityLogEntry[]> => {
			const opts: {
				level?: string;
				source?: string;
				q?: string;
				limit?: number;
				since?: number;
			} = {};
			if (params.level) opts.level = params.level;
			if (params.source) opts.source = params.source;
			if (params.q) opts.q = params.q;
			if (params.limit) opts.limit = params.limit;
			if (params.since) opts.since = params.since;
			return [...deps.activity.logs.list(opts)];
		},

		// --- Runtime introspection ---
		activityRuntime: async (_params: Record<string, never>): Promise<ActivityRuntimeSnapshot> => {
			return deps.activity.runtimeSnapshot();
		},

		// --- Trajectories ---
		activityTrajectoriesList: async (params: {
			limit?: number;
			offset?: number;
			status?: string;
			source?: string;
			q?: string;
		}): Promise<ActivityTrajectoryListResult> => {
			const limit = params.limit ?? 50;
			const offset = params.offset ?? 0;
			const opts: {
				limit: number;
				offset: number;
				status?: string;
				source?: string;
				q?: string;
			} = { limit, offset };
			if (params.status) opts.status = params.status;
			if (params.source) opts.source = params.source;
			if (params.q) opts.q = params.q;
			return deps.activity.trajectories.list(opts);
		},
		activityTrajectoryGet: async (params: { id: string }): Promise<ActivityTrajectoryDetail> => {
			return deps.activity.trajectories.get(params.id);
		},
		activityTrajectoriesExport: async (
			params: { ids?: string[] },
		): Promise<ActivityTrajectoryExport> => {
			const ids = Array.isArray(params.ids) && params.ids.length > 0
				? params.ids
				: (await deps.activity.trajectories.list({ limit: 500 })).trajectories.map((t) => t.id);
			const details = await deps.activity.trajectories.getMany(ids);
			return {
				exportedAt: Date.now(),
				count: details.length,
				trajectories: details,
			};
		},

		// --- Tasks ---
		activityTasksList: async (_params: Record<string, never>): Promise<ActivityTasksSnapshot> => {
			return deps.activity.tasks.snapshot();
		},
		activityTaskRun: async (params: { id: string }): Promise<{ ok: true }> => {
			let success = false;
			let errMsg: string | undefined;
			try {
				success = await deps.activity.tasks.runNow(params.id);
			} catch (err) {
				errMsg = err instanceof Error ? err.message : String(err);
			}
			pensieveAudit({
				action: "task.run",
				target: params.id,
				success,
				...(errMsg ? { error: errMsg } : {}),
				caller: "ui-activity",
				ts: Date.now(),
			});
			if (!success) throw new Error(errMsg ?? "run failed");
			return { ok: true };
		},
		activityTaskPause: async (params: { id: string }): Promise<{ ok: true }> => {
			let success = false;
			let errMsg: string | undefined;
			try {
				success = await deps.activity.tasks.pause(params.id, true);
			} catch (err) {
				errMsg = err instanceof Error ? err.message : String(err);
			}
			pensieveAudit({
				action: "task.pause",
				target: params.id,
				success,
				...(errMsg ? { error: errMsg } : {}),
				caller: "ui-activity",
				ts: Date.now(),
			});
			if (!success) throw new Error(errMsg ?? "pause failed");
			return { ok: true };
		},
		activityTaskResume: async (params: { id: string }): Promise<{ ok: true }> => {
			let success = false;
			let errMsg: string | undefined;
			try {
				success = await deps.activity.tasks.pause(params.id, false);
			} catch (err) {
				errMsg = err instanceof Error ? err.message : String(err);
			}
			pensieveAudit({
				action: "task.resume",
				target: params.id,
				success,
				...(errMsg ? { error: errMsg } : {}),
				caller: "ui-activity",
				ts: Date.now(),
			});
			if (!success) throw new Error(errMsg ?? "resume failed");
			return { ok: true };
		},
		activityTaskDelete: async (params: { id: string }): Promise<{ ok: true }> => {
			let success = false;
			let errMsg: string | undefined;
			try {
				success = await deps.activity.tasks.remove(params.id);
			} catch (err) {
				errMsg = err instanceof Error ? err.message : String(err);
			}
			pensieveAudit({
				action: "task.delete",
				target: params.id,
				success,
				...(errMsg ? { error: errMsg } : {}),
				caller: "ui-activity",
				ts: Date.now(),
			});
			if (!success) throw new Error(errMsg ?? "delete failed");
			return { ok: true };
		},

		// --- Autonomy ---
		activityAutonomy: async (_params: Record<string, never>): Promise<ActivityAutonomySnapshot> => {
			return deps.activity.autonomy.snapshot();
		},
		activityAutonomySetX: async (
			params: { update: ActivityXAutonomyUpdate },
		): Promise<ActivityAutonomySnapshot> => {
			const parsed = validateXAutonomyUpdate(params.update);
			if (!parsed.ok) throw new Error(parsed.error);
			const v = await deps.vault.vault();
			for (const [key, value] of xAutonomyRuntimeSettings(parsed.value)) {
				await v.set(key, value);
			}
			const applied = await deps.activity.autonomy.applyXSettings(parsed.value);
			pensieveAudit({
				action: "autonomy.x.configure",
				success: applied,
				caller: "ui-activity",
				ts: Date.now(),
			});
			return deps.activity.autonomy.snapshot();
		},
		activityAutonomyEnable: async (_params: Record<string, never>): Promise<{ ok: true }> => {
			const success = await deps.activity.autonomy.setEnabled(true);
			pensieveAudit({
				action: "autonomy.enable",
				success,
				caller: "ui-activity",
				ts: Date.now(),
			});
			if (!success) throw new Error("autonomy service not available");
			return { ok: true };
		},
		activityAutonomyDisable: async (_params: Record<string, never>): Promise<{ ok: true }> => {
			const success = await deps.activity.autonomy.setEnabled(false);
			pensieveAudit({
				action: "autonomy.disable",
				success,
				caller: "ui-activity",
				ts: Date.now(),
			});
			if (!success) throw new Error("autonomy service not available");
			return { ok: true };
		},
		activityAutonomySetInterval: async (
			params: { intervalMs: number },
		): Promise<{ ok: true }> => {
			const success = await deps.activity.autonomy.setIntervalMs(params.intervalMs);
			pensieveAudit({
				action: "autonomy.interval",
				target: String(params.intervalMs),
				success,
				caller: "ui-activity",
				ts: Date.now(),
			});
			if (!success) throw new Error("could not set interval");
			return { ok: true };
		},

		// --- Plugins ---
		activityPluginsList: async (_params: Record<string, never>): Promise<ActivityPluginsSnapshot> => {
			return deps.activity.pluginsSnapshot();
		},
		activityPluginsRebuild: async (
			_params: Record<string, never>,
		): Promise<{ ok: boolean; provider: string | null }> => {
			const result = await deps.runtime.rebuild();
			return { ok: !!result, provider: result?.provider ?? null };
		},

		// --- DB ---
		activityDbTablesList: async (
			_params: Record<string, never>,
		): Promise<{ available: boolean; tables: ActivityDbTable[] }> => {
			return {
				available: deps.activity.db.available(),
				tables: await deps.activity.db.listTables(),
			};
		},
		activityDbTableGet: async (
			params: { schema: string; name: string },
		): Promise<ActivityDbTableDetail> => {
			const detail = await deps.activity.db.describeTable(params.schema, params.name);
			if (!detail) throw new Error("not found");
			return detail;
		},
		activityDbQuery: async (params: { sql: string }): Promise<ActivityDbQueryResult> => {
			return deps.activity.db.query(params.sql);
		},
	};
}
