/**
 * Cron / scheduled-prompts RPC. Wire shapes match the legacy HTTP routes
 * 1:1 so swapping `client.*` → `rpc.request.*` is a structural rename:
 *
 *   GET    /api/cron               → cronJobsList    → { jobs }
 *   GET    /api/cron/<id>          → cronJobGet      → { job }
 *   POST   /api/cron               → cronJobCreate   → { ok, job }
 *   PATCH  /api/cron/<id>          → cronJobUpdate   → { ok, job }
 *   DELETE /api/cron/<id>          → cronJobDelete   → { ok }
 *
 * `not found` (HTTP 404) is signaled by the handler throwing — RPC has no
 * status codes, the rejected promise is the not-found channel.
 */

import type { CronJob } from "../../bun/core/cron-service";

export type CronJobCreateInput = {
	schedule: string;
	prompt: string;
	name?: string;
	enabled?: boolean;
};

export type CronJobUpdateInput = {
	schedule?: string;
	prompt?: string;
	name?: string;
	enabled?: boolean;
};

export type CronRequests = {
	cronJobsList: {
		params: Record<string, never>;
		response: { jobs: CronJob[] };
	};
	cronJobGet: {
		params: { id: string };
		response: { job: CronJob };
	};
	cronJobCreate: {
		params: CronJobCreateInput;
		response: { ok: true; job: CronJob };
	};
	cronJobUpdate: {
		params: { id: string; patch: CronJobUpdateInput };
		response: { ok: true; job: CronJob };
	};
	cronJobDelete: {
		params: { id: string };
		response: { ok: true };
	};
};
