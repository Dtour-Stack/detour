/**
 * Cron RPC handlers. Mirror /api/cron/* in src/bun/core/api/server.ts.
 *
 *   - cronJobsList   → CronService.listJobs()
 *   - cronJobGet     → CronService.getJob() [throws on miss]
 *   - cronJobCreate  → CronService.createJob({...input, createdBy: "ui"})
 *   - cronJobUpdate  → CronService.updateJob() [throws on miss]
 *   - cronJobDelete  → CronService.deleteJob() [throws on miss]
 *
 * The "ui" createdBy tag matches the legacy HTTP path so audit logs stay
 * consistent across the migration.
 */

import type { CronJob } from "../../cron-service";
import type { RpcDeps } from "../types";
import type {
	CronJobCreateInput,
	CronJobUpdateInput,
} from "../../../../shared/rpc/cron";

export function cronRequests(deps: RpcDeps) {
	return {
		cronJobsList: async (_params: Record<string, never>): Promise<{ jobs: CronJob[] }> => {
			return { jobs: deps.cron.listJobs() };
		},
		cronJobGet: async (params: { id: string }): Promise<{ job: CronJob }> => {
			const job = deps.cron.getJob(params.id);
			if (!job) throw new Error("not found");
			return { job };
		},
		cronJobCreate: async (params: CronJobCreateInput): Promise<{ ok: true; job: CronJob }> => {
			if (!params.schedule) throw new Error("schedule required");
			if (!params.prompt) throw new Error("prompt required");
			const job = await deps.cron.createJob({
				schedule: params.schedule,
				prompt: params.prompt,
				...(params.name ? { name: params.name } : {}),
				...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
				createdBy: "ui",
			});
			return { ok: true, job };
		},
		cronJobUpdate: async (
			params: { id: string; patch: CronJobUpdateInput },
		): Promise<{ ok: true; job: CronJob }> => {
			const job = await deps.cron.updateJob(params.id, params.patch);
			if (!job) throw new Error("not found");
			return { ok: true, job };
		},
		cronJobDelete: async (params: { id: string }): Promise<{ ok: true }> => {
			const removed = await deps.cron.deleteJob(params.id);
			if (!removed) throw new Error("not found");
			return { ok: true };
		},
	};
}
