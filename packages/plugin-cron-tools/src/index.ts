/**
 * Detour plugin: full CRUD over scheduled prompts the agent can manage itself.
 *
 * Hands the agent CRON_CREATE / CRON_LIST / CRON_READ / CRON_UPDATE /
 * CRON_DELETE so it can wire up its own recurring tasks ("check mentions every
 * 30 minutes", "post a daily standup at 09:00", "remind me in 2 hours") and
 * later edit or remove them. The actual cron engine lives in @detour/core's
 * CronService — this plugin is a thin agent-facing wrapper.
 *
 * Schedule formats accepted by every action that takes one:
 *   every:30s | every:5m | every:1h | every:2d
 *   at:2026-05-10T14:30Z              (ISO timestamp; one-shot)
 *   cron:0 9 * * *                    (5-field standard cron, UTC)
 */

import type {
	Action,
	Handler,
	HandlerCallback,
	IAgentRuntime,
	Plugin,
} from "@elizaos/core";

// Service shape exposed from @detour/core via runtime settings symbol.
// We don't import @detour/core directly to keep this plugin standalone.
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

interface CronServiceShape {
	listJobs(): CronJob[];
	getJob(id: string): CronJob | null;
	createJob(input: {
		name?: string;
		schedule: string;
		prompt: string;
		enabled?: boolean;
		createdBy?: string;
	}): CronJob;
	updateJob(
		id: string,
		patch: { name?: string; schedule?: string; prompt?: string; enabled?: boolean },
	): CronJob | null;
	deleteJob(id: string): boolean;
}

const CRON_SERVICE_GLOBAL = Symbol.for("detour.cron.service");

function getService(): CronServiceShape | null {
	const g = globalThis as unknown as Record<symbol, unknown>;
	return (g[CRON_SERVICE_GLOBAL] as CronServiceShape) ?? null;
}

async function emit(callback: HandlerCallback | undefined, text: string, action: string): Promise<void> {
	if (!callback) return;
	await callback({ text, action });
}

const alwaysValid: Action["validate"] = async () => true;

/**
 * Pull params from a Handler options bag, canonical contract first.
 * See @detour/plugin-x-tweets for the rationale — eliza delivers extracted
 * params at `options.parameters[key]`, but we fall back through top-level
 * and a deep walk for resilience against eliza version drift.
 */
function paramsBag(opts: Record<string, unknown> | undefined): Record<string, unknown> {
	if (!opts) return {};
	const p = (opts as { parameters?: unknown }).parameters;
	if (p && typeof p === "object" && !Array.isArray(p)) return p as Record<string, unknown>;
	return {};
}

function pickString(opts: Record<string, unknown> | undefined, keys: string[]): string | undefined {
	if (!opts) return undefined;
	const params = paramsBag(opts);
	for (const k of keys) {
		const v = params[k];
		if (typeof v === "string" && v.length > 0) return v;
	}
	for (const k of keys) {
		const v = opts[k];
		if (typeof v === "string" && v.length > 0) return v;
	}
	const queue: Record<string, unknown>[] = [opts];
	const seen = new Set<unknown>();
	while (queue.length > 0) {
		const cur = queue.shift()!;
		if (seen.has(cur)) continue;
		seen.add(cur);
		for (const k of keys) {
			const v = cur[k];
			if (typeof v === "string" && v.length > 0) return v;
		}
		for (const v of Object.values(cur)) {
			if (v && typeof v === "object" && !Array.isArray(v)) queue.push(v as Record<string, unknown>);
		}
	}
	return undefined;
}

function pickBool(opts: Record<string, unknown> | undefined, keys: string[]): boolean | undefined {
	if (!opts) return undefined;
	const params = paramsBag(opts);
	for (const k of keys) {
		const v = params[k];
		if (typeof v === "boolean") return v;
		if (v === "true") return true;
		if (v === "false") return false;
	}
	for (const k of keys) {
		const v = opts[k];
		if (typeof v === "boolean") return v;
		if (v === "true") return true;
		if (v === "false") return false;
	}
	const queue: Record<string, unknown>[] = [opts];
	const seen = new Set<unknown>();
	while (queue.length > 0) {
		const cur = queue.shift()!;
		if (seen.has(cur)) continue;
		seen.add(cur);
		for (const k of keys) {
			const v = cur[k];
			if (typeof v === "boolean") return v;
			if (v === "true") return true;
			if (v === "false") return false;
		}
		for (const v of Object.values(cur)) {
			if (v && typeof v === "object" && !Array.isArray(v)) queue.push(v as Record<string, unknown>);
		}
	}
	return undefined;
}

function fmtJob(job: CronJob): string {
	const next = job.nextRunAt ? new Date(job.nextRunAt).toISOString() : "(never)";
	const last = job.lastRunAt ? new Date(job.lastRunAt).toISOString() : "(never)";
	return `[${job.id}] "${job.name}" — schedule=${job.schedule} enabled=${job.enabled} runs=${job.runCount} next=${next} last=${last}`;
}

function ensureService(callback: HandlerCallback | undefined, action: string) {
	const svc = getService();
	if (!svc) {
		void emit(callback, `${action}: cron service not registered`, action);
	}
	return svc;
}

// ── CRON_CREATE ─────────────────────────────────────────────────────────────

const createHandler: Handler = async (_r: IAgentRuntime, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	let schedule = pickString(opts, ["schedule", "when", "interval", "cron"]);
	let prompt = pickString(opts, ["prompt", "task", "instructions", "text"]);
	const name = pickString(opts, ["name", "title"]);
	const enabled = pickBool(opts, ["enabled", "active"]) ?? true;
	if (!schedule || !prompt) {
		const params = (opts?.params ?? {}) as Record<string, unknown>;
		schedule = schedule ?? pickString(params, ["schedule", "when", "interval", "cron"]);
		prompt = prompt ?? pickString(params, ["prompt", "task", "instructions", "text"]);
	}
	if (!schedule) return missing("CRON_CREATE", "schedule", callback);
	if (!prompt) return missing("CRON_CREATE", "prompt", callback);
	const svc = ensureService(callback, "CRON_CREATE");
	if (!svc) return { success: false, error: "no cron service" };
	try {
		const job = svc.createJob({ schedule, prompt, ...(name ? { name } : {}), enabled, createdBy: "agent" });
		await emit(callback, `Created cron job: ${fmtJob(job)}`, "CRON_CREATE");
		return { success: true, job };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		await emit(callback, `CRON_CREATE failed: ${msg}`, "CRON_CREATE");
		return { success: false, error: msg };
	}
};

export const cronCreateAction: Action = {
	name: "CRON_CREATE",
	similes: ["SCHEDULE_TASK", "CREATE_CRON", "ADD_SCHEDULE", "CREATE_REMINDER"],
	description:
		"Create a recurring scheduled prompt the agent will run on its own. Schedule formats: " +
		"`every:30s` | `every:5m` | `every:1h` | `every:2d` for intervals; " +
		"`at:2026-05-10T14:30Z` for one-shot; `cron:0 9 * * *` for standard cron (UTC). " +
		"The `prompt` is what the agent receives via its inbox pipeline when the schedule fires.",
	validate: alwaysValid,
	handler: createHandler,
	examples: [],
	parameters: [
		{ name: "schedule", description: "Schedule expression. See action description for formats.", required: true, schema: { type: "string" as const } },
		{ name: "prompt", description: "What to send the agent when the schedule fires.", required: true, schema: { type: "string" as const } },
		{ name: "name", description: "Human-readable label. Defaults to the schedule string.", required: false, schema: { type: "string" as const } },
		{ name: "enabled", description: "Start enabled (default true).", required: false, schema: { type: "boolean" as const } },
	],
} as Action;

// ── CRON_LIST ───────────────────────────────────────────────────────────────

const listHandler: Handler = async (_r, _m, _s, _options, callback) => {
	const svc = ensureService(callback, "CRON_LIST");
	if (!svc) return { success: false, error: "no cron service" };
	const jobs = svc.listJobs();
	const summary = jobs.length === 0 ? "No cron jobs." : jobs.map(fmtJob).join("\n");
	await emit(callback, summary, "CRON_LIST");
	return { success: true, jobs };
};

export const cronListAction: Action = {
	name: "CRON_LIST",
	similes: ["LIST_CRON", "LIST_SCHEDULES", "LIST_REMINDERS", "SHOW_CRON"],
	description: "List every scheduled prompt the agent currently has, with schedules, run counts, and next-fire times.",
	validate: alwaysValid,
	handler: listHandler,
	examples: [],
	parameters: [],
} as Action;

// ── CRON_READ ───────────────────────────────────────────────────────────────

const readHandler: Handler = async (_r, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const id = pickString(opts, ["id", "jobId"]) ?? pickString((opts?.params ?? {}) as Record<string, unknown>, ["id", "jobId"]);
	if (!id) return missing("CRON_READ", "id", callback);
	const svc = ensureService(callback, "CRON_READ");
	if (!svc) return { success: false, error: "no cron service" };
	const job = svc.getJob(id);
	if (!job) {
		await emit(callback, `No cron job with id ${id}.`, "CRON_READ");
		return { success: false, error: "not found" };
	}
	await emit(callback, `${fmtJob(job)}\nprompt: ${job.prompt.slice(0, 200)}`, "CRON_READ");
	return { success: true, job };
};

export const cronReadAction: Action = {
	name: "CRON_READ",
	similes: ["READ_CRON", "GET_CRON", "SHOW_SCHEDULE"],
	description: "Look up a single scheduled prompt by id.",
	validate: alwaysValid,
	handler: readHandler,
	examples: [],
	parameters: [
		{ name: "id", description: "Cron job id (UUID).", required: true, schema: { type: "string" as const } },
	],
} as Action;

// ── CRON_UPDATE ─────────────────────────────────────────────────────────────

const updateHandler: Handler = async (_r, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const params = (opts?.params ?? {}) as Record<string, unknown>;
	const id = pickString(opts, ["id", "jobId"]) ?? pickString(params, ["id", "jobId"]);
	if (!id) return missing("CRON_UPDATE", "id", callback);
	const svc = ensureService(callback, "CRON_UPDATE");
	if (!svc) return { success: false, error: "no cron service" };
	const patch: { name?: string; schedule?: string; prompt?: string; enabled?: boolean } = {};
	const name = pickString(opts, ["name", "title"]) ?? pickString(params, ["name", "title"]);
	const schedule = pickString(opts, ["schedule", "when", "interval", "cron"]) ?? pickString(params, ["schedule", "when", "interval", "cron"]);
	const prompt = pickString(opts, ["prompt", "task", "instructions", "text"]) ?? pickString(params, ["prompt", "task", "instructions", "text"]);
	const enabled = pickBool(opts, ["enabled", "active"]) ?? pickBool(params, ["enabled", "active"]);
	if (name !== undefined) patch.name = name;
	if (schedule !== undefined) patch.schedule = schedule;
	if (prompt !== undefined) patch.prompt = prompt;
	if (enabled !== undefined) patch.enabled = enabled;
	if (Object.keys(patch).length === 0) {
		await emit(callback, "CRON_UPDATE: nothing to update — provide at least one of name, schedule, prompt, enabled.", "CRON_UPDATE");
		return { success: false, error: "no patch fields" };
	}
	try {
		const job = svc.updateJob(id, patch);
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
};

export const cronUpdateAction: Action = {
	name: "CRON_UPDATE",
	similes: ["UPDATE_CRON", "EDIT_CRON", "EDIT_SCHEDULE", "MODIFY_CRON", "DISABLE_CRON", "ENABLE_CRON"],
	description: "Modify an existing scheduled prompt — change schedule, prompt body, name, or enable/disable. Provide id plus any subset of fields.",
	validate: alwaysValid,
	handler: updateHandler,
	examples: [],
	parameters: [
		{ name: "id", description: "Cron job id (UUID).", required: true, schema: { type: "string" as const } },
		{ name: "schedule", description: "New schedule expression.", required: false, schema: { type: "string" as const } },
		{ name: "prompt", description: "New prompt body.", required: false, schema: { type: "string" as const } },
		{ name: "name", description: "New label.", required: false, schema: { type: "string" as const } },
		{ name: "enabled", description: "Enable/disable without deleting.", required: false, schema: { type: "boolean" as const } },
	],
} as Action;

// ── CRON_DELETE ─────────────────────────────────────────────────────────────

const deleteHandler: Handler = async (_r, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const id = pickString(opts, ["id", "jobId"]) ?? pickString((opts?.params ?? {}) as Record<string, unknown>, ["id", "jobId"]);
	if (!id) return missing("CRON_DELETE", "id", callback);
	const svc = ensureService(callback, "CRON_DELETE");
	if (!svc) return { success: false, error: "no cron service" };
	const removed = svc.deleteJob(id);
	if (!removed) {
		await emit(callback, `No cron job with id ${id}.`, "CRON_DELETE");
		return { success: false, error: "not found" };
	}
	await emit(callback, `Deleted cron job ${id}.`, "CRON_DELETE");
	return { success: true };
};

export const cronDeleteAction: Action = {
	name: "CRON_DELETE",
	similes: ["DELETE_CRON", "REMOVE_CRON", "REMOVE_SCHEDULE", "CANCEL_CRON"],
	description: "Permanently remove a scheduled prompt by id. Use CRON_UPDATE with enabled=false instead if you might want to re-enable later.",
	validate: alwaysValid,
	handler: deleteHandler,
	examples: [],
	parameters: [
		{ name: "id", description: "Cron job id (UUID).", required: true, schema: { type: "string" as const } },
	],
} as Action;

async function missing(action: string, field: string, callback: HandlerCallback | undefined) {
	const msg = `${action} requires a \`${field}\` parameter.`;
	await emit(callback, msg, action);
	return { success: false, error: msg };
}

// ── Plugin export ───────────────────────────────────────────────────────────

export const cronToolsPlugin: Plugin = {
	name: "cron-tools",
	description:
		"Lets the agent create, list, read, update, and delete its own scheduled prompts. " +
		"Schedules support intervals (every:5m), one-shot timestamps (at:2026-05-10T14:30Z), " +
		"and 5-field cron (cron:0 9 * * *, UTC). When a schedule fires, the stored prompt is " +
		"injected through the same inbox pipeline as user messages.",
	actions: [cronCreateAction, cronListAction, cronReadAction, cronUpdateAction, cronDeleteAction],
};

export default cronToolsPlugin;
