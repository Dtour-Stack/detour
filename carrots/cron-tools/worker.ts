/**
 * cron-tools carrot worker.
 *
 * Exposes CRON_CREATE / CRON_LIST / CRON_READ / CRON_UPDATE / CRON_DELETE
 * actions backed by Detour core's CronService — reached over the bridge
 * via `rt.service("cron")`.
 *
 * Schedule formats accepted by every action that takes one:
 *   every:30s | every:5m | every:1h | every:2d
 *   at:2026-05-10T14:30Z              (ISO timestamp; one-shot)
 *   cron:0 9 * * *                    (5-field standard cron, UTC)
 */

import { defineCarrot, type CarrotHandlerCallback } from "../../src/bun/carrot-sdk";

interface CronJob {
	id: string;
	name: string;
	schedule: string;
	prompt: string;
	enabled: boolean;
	createdAt: number;
	createdBy: string;
	updatedAt: number;
	lastRunAt?: number;
	nextRunAt?: number;
	runCount: number;
	lastError?: string;
}

interface CronService {
	listJobs(): CronJob[];
	getJob(id: string): CronJob | null;
	createJob(input: { name?: string; schedule: string; prompt: string; enabled?: boolean; createdBy?: string }): CronJob;
	updateJob(id: string, patch: { name?: string; schedule?: string; prompt?: string; enabled?: boolean }): CronJob | null;
	deleteJob(id: string): boolean;
}

function fmtJob(job: CronJob): string {
	const next = job.nextRunAt ? new Date(job.nextRunAt).toISOString() : "(never)";
	const last = job.lastRunAt ? new Date(job.lastRunAt).toISOString() : "(never)";
	return `[${job.id}] "${job.name}" — schedule=${job.schedule} enabled=${job.enabled} runs=${job.runCount} next=${next} last=${last}`;
}

async function emit(callback: CarrotHandlerCallback | undefined, text: string, action: string): Promise<void> {
	if (callback) await callback({ text, action });
}

function paramsBag(opts: Record<string, unknown> | undefined): Record<string, unknown> {
	if (!opts) return {};
	const p = (opts as { parameters?: unknown }).parameters;
	return p && typeof p === "object" && !Array.isArray(p) ? p as Record<string, unknown> : {};
}

function pickString(opts: Record<string, unknown> | undefined, keys: string[]): string | undefined {
	if (!opts) return undefined;
	const sources = [paramsBag(opts), opts, (opts.params ?? {}) as Record<string, unknown>];
	for (const src of sources) {
		for (const key of keys) {
			const v = src[key];
			if (typeof v === "string" && v.length > 0) return v;
		}
	}
	return undefined;
}

function pickBool(opts: Record<string, unknown> | undefined, keys: string[]): boolean | undefined {
	if (!opts) return undefined;
	const sources = [paramsBag(opts), opts, (opts.params ?? {}) as Record<string, unknown>];
	for (const src of sources) {
		for (const key of keys) {
			const v = src[key];
			if (typeof v === "boolean") return v;
			if (v === "true") return true;
			if (v === "false") return false;
		}
	}
	return undefined;
}

defineCarrot({
	plugin: {
		name: "cron-tools",
		description:
			"Lets the agent create, list, read, update, and delete its own scheduled prompts. " +
			"Schedules support intervals (every:5m), one-shot timestamps (at:2026-05-10T14:30Z), " +
			"and 5-field cron (cron:0 9 * * *, UTC). When a schedule fires, the stored prompt is " +
			"injected through the same inbox pipeline as user messages.",
		actions: [
			{
				name: "CRON_CREATE",
				similes: ["SCHEDULE_TASK", "CREATE_CRON", "ADD_SCHEDULE", "CREATE_REMINDER"],
				description:
					"Create a recurring scheduled prompt the agent will run on its own. Schedule formats: " +
					"`every:30s` | `every:5m` | `every:1h` | `every:2d` for intervals; " +
					"`at:2026-05-10T14:30Z` for one-shot; `cron:0 9 * * *` for standard cron (UTC). " +
					"The `prompt` is what the agent receives via its inbox pipeline when the schedule fires.",
				parameters: [
					{ name: "schedule", description: "Schedule expression. See action description for formats.", required: true, schema: { type: "string" } },
					{ name: "prompt", description: "What to send the agent when the schedule fires.", required: true, schema: { type: "string" } },
					{ name: "name", description: "Human-readable label. Defaults to the schedule string.", required: false, schema: { type: "string" } },
					{ name: "enabled", description: "Start enabled (default true).", required: false, schema: { type: "boolean" } },
				],
				handler: async (rt, _msg, _state, options, callback) => {
					const opts = options as Record<string, unknown> | undefined;
					const schedule = pickString(opts, ["schedule", "when", "interval", "cron"]);
					const prompt = pickString(opts, ["prompt", "task", "instructions", "text"]);
					const name = pickString(opts, ["name", "title"]);
					const enabled = pickBool(opts, ["enabled", "active"]) ?? true;
					if (!schedule) return missing("CRON_CREATE", "schedule", callback);
					if (!prompt) return missing("CRON_CREATE", "prompt", callback);
					const cron = rt.service<CronService>("cron");
					try {
						const job = await cron.createJob({ schedule, prompt, ...(name ? { name } : {}), enabled, createdBy: "agent" });
						await emit(callback, `Created cron job: ${fmtJob(job)}`, "CRON_CREATE");
						return { success: true, job };
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						await emit(callback, `CRON_CREATE failed: ${msg}`, "CRON_CREATE");
						return { success: false, error: msg };
					}
				},
			},
			{
				name: "CRON_LIST",
				similes: ["LIST_CRON", "LIST_SCHEDULES", "LIST_REMINDERS", "SHOW_CRON"],
				description: "List every scheduled prompt the agent currently has, with schedules, run counts, and next-fire times.",
				handler: async (rt, _m, _s, _opts, callback) => {
					const cron = rt.service<CronService>("cron");
					const jobs = await cron.listJobs();
					const summary = jobs.length === 0 ? "No cron jobs." : jobs.map(fmtJob).join("\n");
					await emit(callback, summary, "CRON_LIST");
					return { success: true, jobs };
				},
			},
			{
				name: "CRON_READ",
				similes: ["READ_CRON", "GET_CRON", "SHOW_SCHEDULE"],
				description: "Look up a single scheduled prompt by id.",
				parameters: [
					{ name: "id", description: "Cron job id (UUID).", required: true, schema: { type: "string" } },
				],
				handler: async (rt, _m, _s, options, callback) => {
					const id = pickString(options as Record<string, unknown> | undefined, ["id", "jobId"]);
					if (!id) return missing("CRON_READ", "id", callback);
					const cron = rt.service<CronService>("cron");
					const job = await cron.getJob(id);
					if (!job) {
						await emit(callback, `No cron job with id ${id}.`, "CRON_READ");
						return { success: false, error: "not found" };
					}
					await emit(callback, `${fmtJob(job)}\nprompt: ${job.prompt.slice(0, 200)}`, "CRON_READ");
					return { success: true, job };
				},
			},
			{
				name: "CRON_UPDATE",
				similes: ["UPDATE_CRON", "EDIT_CRON", "EDIT_SCHEDULE", "MODIFY_CRON", "DISABLE_CRON", "ENABLE_CRON"],
				description: "Modify an existing scheduled prompt — change schedule, prompt body, name, or enable/disable. Provide id plus any subset of fields.",
				parameters: [
					{ name: "id", description: "Cron job id (UUID).", required: true, schema: { type: "string" } },
					{ name: "schedule", description: "New schedule expression.", required: false, schema: { type: "string" } },
					{ name: "prompt", description: "New prompt body.", required: false, schema: { type: "string" } },
					{ name: "name", description: "New label.", required: false, schema: { type: "string" } },
					{ name: "enabled", description: "Enable/disable without deleting.", required: false, schema: { type: "boolean" } },
				],
				handler: async (rt, _m, _s, options, callback) => {
					const opts = options as Record<string, unknown> | undefined;
					const id = pickString(opts, ["id", "jobId"]);
					if (!id) return missing("CRON_UPDATE", "id", callback);
					const patch: { name?: string; schedule?: string; prompt?: string; enabled?: boolean } = {};
					const name = pickString(opts, ["name", "title"]);
					const schedule = pickString(opts, ["schedule", "when", "interval", "cron"]);
					const prompt = pickString(opts, ["prompt", "task", "instructions", "text"]);
					const enabled = pickBool(opts, ["enabled", "active"]);
					if (name !== undefined) patch.name = name;
					if (schedule !== undefined) patch.schedule = schedule;
					if (prompt !== undefined) patch.prompt = prompt;
					if (enabled !== undefined) patch.enabled = enabled;
					if (Object.keys(patch).length === 0) {
						await emit(callback, "CRON_UPDATE: nothing to update — provide at least one of name, schedule, prompt, enabled.", "CRON_UPDATE");
						return { success: false, error: "no patch fields" };
					}
					const cron = rt.service<CronService>("cron");
					try {
						const job = await cron.updateJob(id, patch);
						if (!job) {
							await emit(callback, `No cron job with id ${id}.`, "CRON_UPDATE");
							return { success: false, error: "not found" };
						}
						await emit(callback, `Updated cron job: ${fmtJob(job)}`, "CRON_UPDATE");
						return { success: true, job };
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						await emit(callback, `CRON_UPDATE failed: ${msg}`, "CRON_UPDATE");
						return { success: false, error: msg };
					}
				},
			},
			{
				name: "CRON_DELETE",
				similes: ["DELETE_CRON", "REMOVE_CRON", "REMOVE_SCHEDULE", "CANCEL_CRON"],
				description: "Permanently remove a scheduled prompt by id. Use CRON_UPDATE with enabled=false instead if you might want to re-enable later.",
				parameters: [
					{ name: "id", description: "Cron job id (UUID).", required: true, schema: { type: "string" } },
				],
				handler: async (rt, _m, _s, options, callback) => {
					const id = pickString(options as Record<string, unknown> | undefined, ["id", "jobId"]);
					if (!id) return missing("CRON_DELETE", "id", callback);
					const cron = rt.service<CronService>("cron");
					const removed = await cron.deleteJob(id);
					if (!removed) {
						await emit(callback, `No cron job with id ${id}.`, "CRON_DELETE");
						return { success: false, error: "not found" };
					}
					await emit(callback, `Deleted cron job ${id}.`, "CRON_DELETE");
					return { success: true };
				},
			},
		],
	},
});

async function missing(action: string, field: string, callback: CarrotHandlerCallback | undefined) {
	const msg = `${action} requires a \`${field}\` parameter.`;
	await emit(callback, msg, action);
	return { success: false, error: msg };
}
