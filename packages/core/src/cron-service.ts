/**
 * Cron / scheduled-prompt manager.
 *
 * Two surfaces:
 *   1. JSON store at ~/.detour/cron.json — survives restarts and lets the
 *      cron list be edited even when the AgentRuntime isn't built yet.
 *   2. Each enabled job is mirrored as an eliza Task (worker name DETOUR_CRON)
 *      so it appears in Activity > Tasks for free, with the same run/pause/
 *      resume controls the existing pane already wires up. Eliza's own
 *      TaskService timer drives execution; we just register one worker that
 *      forwards the matched job's prompt into the inbox pipeline.
 *
 * Schedule formats:
 *   every:30s | every:5m | every:1h | every:2d   (interval)
 *   at:2026-05-10T14:30Z                          (one-shot ISO)
 *   cron:0 9 * * *                                (5-field cron, UTC)
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger, type IAgentRuntime, type Task, type UUID } from "@elizaos/core";

const CRON_DIR = join(homedir(), ".detour");
const CRON_FILE = join(CRON_DIR, "cron.json");
const AUDIT_FILE = join(CRON_DIR, "cron-audit.jsonl");
const SERVICE_GLOBAL_KEY = Symbol.for("detour.cron.service");
export const CRON_TASK_WORKER_NAME = "DETOUR_CRON" as const;
const CRON_TASK_TAGS = ["queue", "repeat", "detour-cron"] as const;
const ONE_SHOT_INTERVAL_MS = 24 * 60 * 60 * 1000; // placeholder updateInterval for "at:" jobs

export type CronScheduleType = "every" | "at" | "cron";

export interface CronJob {
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
	taskId?: string;
}

export interface CronJobInput {
	name?: string;
	schedule: string;
	prompt: string;
	enabled?: boolean;
	createdBy?: string;
}

export interface CronJobUpdate {
	name?: string;
	schedule?: string;
	prompt?: string;
	enabled?: boolean;
}

interface CronStore {
	version: 1;
	jobs: CronJob[];
	/** Marker so we only seed default jobs once. Survives "delete all jobs" — once it's been set, the user clearly knows about defaults and can re-add them by hand. */
	defaultsSeededAt?: number;
}

interface ParsedSchedule {
	type: CronScheduleType;
	intervalMs?: number;
	at?: number;
	cronFields?: number[][];
}

export class CronService {
	private jobs = new Map<string, CronJob>();
	private dispatch: ((job: CronJob) => Promise<void>) | null = null;
	private parsedCache = new Map<string, ParsedSchedule>();
	private runtime: IAgentRuntime | null = null;
	private defaultsSeededAt: number | undefined;
	private readonly self: string;

	constructor() {
		this.self = `cron:${process.pid}`;
	}

	/** Forward to the inbox pipeline (or whatever the host wires up). */
	setDispatcher(fn: (job: CronJob) => Promise<void>): void {
		this.dispatch = fn;
	}

	start(): void {
		this.load();
		this.seedDefaults();
		// Publish self to global so @detour/plugin-cron-tools can find us
		// without a hard import dependency on @detour/core.
		(globalThis as Record<symbol, unknown>)[SERVICE_GLOBAL_KEY] = this;
		logger.info({ src: "cron", count: this.jobs.size }, "cron service started");
	}

	/**
	 * On first run, install a default job that has the agent poll X for
	 * mentions/replies and respond. X is the only channel we ship that's
	 * pull-based — Discord / Telegram / iMessage already push inbound
	 * messages through the agent automatically. Without this, the squirrel
	 * sits silent until the user manually triggers X_NOTIFICATIONS.
	 *
	 * Idempotent: tracks `defaultsSeededAt` in the store so re-runs (and
	 * "delete all jobs" by the user) won't re-create the job they removed.
	 */
	private seedDefaults(): void {
		if (this.defaultsSeededAt) return;
		const now = Date.now();
		const id = crypto.randomUUID();
		const job: CronJob = {
			id,
			name: "Check X mentions",
			schedule: "every:10m",
			prompt: [
				"Call X_NOTIFICATIONS to fetch new mentions, replies, follows, and likes on @detour_squirrel.",
				"For each genuine mention or reply addressed to me that I haven't responded to yet, use X_REPLY in-character:",
				"- lowercase, deadpan, short. one or two sentences max. no hashtags, no emoji-spam.",
				"- if it's a builder-curious mention, be helpful but blunt. point them to elizaOS / Milady / Cozy Devs (discord.gg/BfTrruWcZ) when relevant.",
				"- if it's @dEXploarer, channel his cadence (yall, dat, idk, :)).",
				"- if it's a roast bait or a hater, either ignore or one-line back at them. no lectures.",
				"- skip pure likes / follows / retweets — no reply needed.",
				"- skip anything that looks like spam, airdrop bait, or a thread I'm not part of.",
				"If there are zero new actionable mentions, take no action and don't post anything just to fill space.",
			].join("\n"),
			enabled: true,
			createdAt: now,
			createdBy: "system:default",
			updatedAt: now,
			runCount: 0,
		};
		this.jobs.set(id, job);
		this.defaultsSeededAt = now;
		this.persist();
		this.audit({ action: "seed-default", jobId: id, ts: now, by: "system" });
		logger.info({ src: "cron", jobId: id }, "seeded default 'Check X mentions' cron job");
	}

	stop(): void {
		delete (globalThis as Record<symbol, unknown>)[SERVICE_GLOBAL_KEY];
	}

	/**
	 * Bind to a freshly-built runtime. Registers the DETOUR_CRON task worker
	 * and reconciles persisted jobs into eliza Tasks. Idempotent — safe to
	 * call on every rebuild.
	 */
	async attachRuntime(runtime: IAgentRuntime): Promise<void> {
		this.runtime = runtime;
		const r = runtime as unknown as {
			getTaskWorker?: (name: string) => unknown;
			registerTaskWorker: (worker: {
				name: string;
				execute: (rt: IAgentRuntime, options: unknown, task: Task) => Promise<undefined | { nextInterval?: number }>;
				shouldRun?: (rt: IAgentRuntime, task: Task) => Promise<boolean>;
			}) => void;
		};
		if (!r.getTaskWorker?.(CRON_TASK_WORKER_NAME)) {
			r.registerTaskWorker({
				name: CRON_TASK_WORKER_NAME,
				shouldRun: async (_rt, task) => {
					const id = (task.metadata?.values as Record<string, unknown> | undefined)?.cronJobId as string | undefined;
					if (!id) return false;
					const job = this.jobs.get(id);
					if (!job || !job.enabled) return false;
					return true;
				},
				execute: async (_rt, _opts, task) => {
					const id = (task.metadata?.values as Record<string, unknown> | undefined)?.cronJobId as string | undefined;
					if (!id) return undefined;
					const job = this.jobs.get(id);
					if (!job) return undefined;
					await this.fire(job);
					const parsed = this.parsed(job);
					if (parsed?.type === "at") {
						// One-shot — task self-deletes by returning a 0 interval is
						// not supported; instead we delete the row + the in-memory job.
						await this.deleteJob(job.id);
						return undefined;
					}
					return parsed?.intervalMs ? { nextInterval: parsed.intervalMs } : undefined;
				},
			});
		}
		// Reconcile: every persisted job that's enabled should have a Task row.
		for (const job of this.jobs.values()) {
			if (!job.enabled) continue;
			if (!job.taskId) {
				try {
					const taskId = await this.createElizaTask(job);
					job.taskId = taskId;
				} catch (err) {
					logger.warn({ src: "cron", jobId: job.id, err: err instanceof Error ? err.message : err }, "create eliza task failed");
				}
			}
		}
		this.persist();
	}

	listJobs(): CronJob[] {
		return Array.from(this.jobs.values()).sort((a, b) => a.createdAt - b.createdAt);
	}

	getJob(id: string): CronJob | null {
		return this.jobs.get(id) ?? null;
	}

	async createJob(input: CronJobInput): Promise<CronJob> {
		const parsed = this.parseSchedule(input.schedule);
		if (!parsed) {
			throw new Error(`Invalid schedule: ${input.schedule}. Examples: every:30s | at:2026-05-10T14:30Z | cron:0 9 * * *`);
		}
		if (!input.prompt || input.prompt.trim().length === 0) {
			throw new Error("Cron job requires a non-empty prompt");
		}
		const id = crypto.randomUUID();
		const now = Date.now();
		const job: CronJob = {
			id,
			name: input.name ?? input.schedule,
			schedule: input.schedule,
			prompt: input.prompt,
			enabled: input.enabled !== false,
			createdAt: now,
			createdBy: input.createdBy ?? "user",
			updatedAt: now,
			runCount: 0,
			nextRunAt: this.computeNextRun(parsed, now),
		};
		this.jobs.set(id, job);
		this.parsedCache.set(id, parsed);
		if (job.enabled && this.runtime) {
			try {
				job.taskId = await this.createElizaTask(job);
			} catch (err) {
				logger.warn({ src: "cron", jobId: id, err: err instanceof Error ? err.message : err }, "task mirror failed");
			}
		}
		this.persist();
		this.audit({ action: "create", jobId: id, ts: now, by: job.createdBy });
		return job;
	}

	async updateJob(id: string, patch: CronJobUpdate): Promise<CronJob | null> {
		const job = this.jobs.get(id);
		if (!job) return null;
		if (patch.schedule !== undefined) {
			const parsed = this.parseSchedule(patch.schedule);
			if (!parsed) throw new Error(`Invalid schedule: ${patch.schedule}`);
			job.schedule = patch.schedule;
			this.parsedCache.set(id, parsed);
			job.nextRunAt = this.computeNextRun(parsed, Date.now());
		}
		if (patch.prompt !== undefined) job.prompt = patch.prompt;
		if (patch.name !== undefined) job.name = patch.name;
		if (patch.enabled !== undefined) job.enabled = patch.enabled;
		job.updatedAt = Date.now();
		// Sync mirror task — easier to delete + recreate than patch in place.
		if (this.runtime && job.taskId) {
			try {
				await (this.runtime as unknown as { deleteTask: (id: UUID) => Promise<void> }).deleteTask(job.taskId as UUID);
			} catch { /* row may already be gone */ }
			job.taskId = undefined;
		}
		if (this.runtime && job.enabled) {
			try {
				job.taskId = await this.createElizaTask(job);
			} catch (err) {
				logger.warn({ src: "cron", jobId: id, err: err instanceof Error ? err.message : err }, "task mirror update failed");
			}
		}
		this.persist();
		this.audit({ action: "update", jobId: id, ts: Date.now(), patch });
		return job;
	}

	async deleteJob(id: string): Promise<boolean> {
		const job = this.jobs.get(id);
		if (!job) return false;
		if (this.runtime && job.taskId) {
			try {
				await (this.runtime as unknown as { deleteTask: (id: UUID) => Promise<void> }).deleteTask(job.taskId as UUID);
			} catch { /* best-effort */ }
		}
		this.jobs.delete(id);
		this.parsedCache.delete(id);
		this.persist();
		this.audit({ action: "delete", jobId: id, ts: Date.now() });
		return true;
	}

	private async fire(job: CronJob): Promise<void> {
		const now = Date.now();
		try {
			if (this.dispatch) await this.dispatch(job);
			job.lastRunAt = now;
			job.runCount += 1;
			delete job.lastError;
			this.audit({ action: "fire", jobId: job.id, ts: now });
		} catch (err) {
			job.lastError = err instanceof Error ? err.message : String(err);
			logger.warn({ src: "cron", jobId: job.id, err: job.lastError }, "cron job dispatch failed");
			this.audit({ action: "fire-failed", jobId: job.id, ts: now, error: job.lastError });
		}
		const parsed = this.parsed(job);
		if (parsed) job.nextRunAt = this.computeNextRun(parsed, now + 1);
		this.persist();
	}

	private async createElizaTask(job: CronJob): Promise<string> {
		const runtime = this.runtime;
		if (!runtime) throw new Error("no runtime");
		const parsed = this.parsed(job);
		const interval = parsed?.intervalMs ?? ONE_SHOT_INTERVAL_MS;
		const r = runtime as unknown as {
			createTask: (task: Task) => Promise<UUID>;
			agentId: UUID;
		};
		const id = await r.createTask({
			name: CRON_TASK_WORKER_NAME,
			description: `cron:${job.name}`,
			tags: [...CRON_TASK_TAGS],
			metadata: {
				updateInterval: interval,
				updatedAt: Date.now(),
				values: { cronJobId: job.id, schedule: job.schedule },
			},
		} as Task);
		return id;
	}

	private parsed(job: CronJob): ParsedSchedule | null {
		let p = this.parsedCache.get(job.id);
		if (p) return p;
		const fresh = this.parseSchedule(job.schedule);
		if (fresh) {
			this.parsedCache.set(job.id, fresh);
			p = fresh;
		}
		return p ?? null;
	}

	private parseSchedule(s: string): ParsedSchedule | null {
		const trimmed = s.trim();
		if (trimmed.startsWith("every:")) {
			const ms = parseInterval(trimmed.slice(6).trim());
			if (!ms || ms < 1000) return null;
			return { type: "every", intervalMs: ms };
		}
		if (trimmed.startsWith("at:")) {
			const t = Date.parse(trimmed.slice(3).trim());
			if (Number.isNaN(t)) return null;
			return { type: "at", at: t };
		}
		if (trimmed.startsWith("cron:")) {
			const fields = parseCronFields(trimmed.slice(5).trim());
			if (!fields) return null;
			// Eliza's task scheduler runs on updateInterval, not crontab. We
			// approximate cron schedules by computing the next match and using
			// (next - now) as the interval. The shouldRun gate then re-checks
			// the cron expression so we never fire too early on drift.
			const next = computeNextCronRun(fields, Date.now());
			return { type: "cron", cronFields: fields, intervalMs: Math.max(60_000, next - Date.now()) };
		}
		return null;
	}

	private computeNextRun(parsed: ParsedSchedule, fromMs: number): number | undefined {
		if (parsed.type === "every" && parsed.intervalMs) return fromMs + parsed.intervalMs;
		if (parsed.type === "at" && parsed.at) return parsed.at > fromMs ? parsed.at : undefined;
		if (parsed.type === "cron" && parsed.cronFields) {
			return computeNextCronRun(parsed.cronFields, fromMs);
		}
		return undefined;
	}

	private load(): void {
		try {
			if (!existsSync(CRON_FILE)) return;
			const raw = readFileSync(CRON_FILE, "utf8");
			const store = JSON.parse(raw) as CronStore;
			for (const job of store.jobs ?? []) this.jobs.set(job.id, job);
			if (store.defaultsSeededAt) this.defaultsSeededAt = store.defaultsSeededAt;
			logger.info({ src: "cron", count: this.jobs.size }, "cron jobs loaded");
		} catch (err) {
			logger.warn({ src: "cron", err: err instanceof Error ? err.message : err }, "cron load failed");
		}
	}

	private persist(): void {
		try {
			if (!existsSync(CRON_DIR)) mkdirSync(CRON_DIR, { recursive: true });
			const store: CronStore = {
				version: 1,
				jobs: Array.from(this.jobs.values()),
				...(this.defaultsSeededAt ? { defaultsSeededAt: this.defaultsSeededAt } : {}),
			};
			writeFileSync(CRON_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
		} catch (err) {
			logger.warn({ src: "cron", err: err instanceof Error ? err.message : err }, "cron persist failed");
		}
	}

	private audit(record: Record<string, unknown>): void {
		try {
			if (!existsSync(CRON_DIR)) mkdirSync(CRON_DIR, { recursive: true });
			appendFileSync(AUDIT_FILE, `${JSON.stringify({ ...record, by: record.by ?? this.self })}\n`, { mode: 0o600 });
		} catch {
			// best-effort
		}
	}
}

function parseInterval(s: string): number | null {
	if (!s) return null;
	const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(s);
	if (!m) {
		const n = Number(s);
		return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
	}
	const value = Number(m[1]);
	const unit = m[2] ?? "ms";
	const mult: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
	return Math.floor(value * (mult[unit] ?? 1));
}

function parseCronFields(expr: string): number[][] | null {
	const parts = expr.split(/\s+/);
	if (parts.length !== 5) return null;
	const ranges = [
		{ min: 0, max: 59 }, { min: 0, max: 23 }, { min: 1, max: 31 }, { min: 1, max: 12 }, { min: 0, max: 6 },
	];
	const out: number[][] = [];
	for (let i = 0; i < 5; i++) {
		const list = expandCronField(parts[i]!, ranges[i]!.min, ranges[i]!.max);
		if (!list) return null;
		out.push(list);
	}
	return out;
}

function expandCronField(field: string, min: number, max: number): number[] | null {
	const all: number[] = [];
	for (const segment of field.split(",")) {
		let stepStr: string | null = null;
		let body = segment;
		const slashIdx = segment.indexOf("/");
		if (slashIdx >= 0) {
			body = segment.slice(0, slashIdx);
			stepStr = segment.slice(slashIdx + 1);
		}
		const step = stepStr ? Number(stepStr) : 1;
		if (!Number.isFinite(step) || step <= 0) return null;
		let lo = min;
		let hi = max;
		if (body !== "*" && body !== "") {
			if (body.includes("-")) {
				const [aRaw, bRaw] = body.split("-");
				const a = Number(aRaw);
				const b = Number(bRaw);
				if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
				lo = a; hi = b;
			} else {
				const v = Number(body);
				if (!Number.isFinite(v)) return null;
				lo = v; hi = v;
			}
		}
		if (lo < min || hi > max || lo > hi) return null;
		for (let v = lo; v <= hi; v += step) all.push(v);
	}
	return Array.from(new Set(all)).sort((a, b) => a - b);
}

function computeNextCronRun(fields: number[][], fromMs: number): number {
	const [mins, hrs, doms, months, dows] = fields as [number[], number[], number[], number[], number[]];
	const start = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
	const limit = start + 366 * 86_400_000;
	for (let t = start; t < limit; t += 60_000) {
		const d = new Date(t);
		if (!mins.includes(d.getUTCMinutes())) continue;
		if (!hrs.includes(d.getUTCHours())) continue;
		if (!months.includes(d.getUTCMonth() + 1)) continue;
		const domMatch = doms.includes(d.getUTCDate());
		const dowMatch = dows.includes(d.getUTCDay());
		if (!domMatch && !dowMatch) continue;
		return t;
	}
	return start;
}
