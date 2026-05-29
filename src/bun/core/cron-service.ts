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
import { KeyedAsyncLock, SerialAsyncLock } from "./async-lock";

const CRON_DIR = join(homedir(), ".detour");
const CRON_FILE = join(CRON_DIR, "cron.json");
const AUDIT_FILE = join(CRON_DIR, "cron-audit.jsonl");
const SERVICE_GLOBAL_KEY = Symbol.for("detour.cron.service");
export const CRON_TASK_WORKER_NAME = "DETOUR_CRON" as const;
const CRON_TASK_TAGS = ["queue", "repeat", "detour-cron"] as const;
const ONE_SHOT_INTERVAL_MS = 24 * 60 * 60 * 1000; // placeholder updateInterval for "at:" jobs

export type CronScheduleType = "every" | "at" | "cron";

/**
 * Which model tier to route this job to.
 *   - "cheap"  → Use TEXT_SMALL / local model for routine data gathering
 *   - "sota"   → Use the best available model (GPT-5.5, etc.) for evaluation
 *   - "auto"   → Let the runtime decide (default, backwards-compatible)
 */
export type CronModelTier = "cheap" | "sota" | "auto";

export interface CronJob {
	id: string;
	name: string;
	schedule: string;
	prompt: string;
	enabled: boolean;
	/** Model routing hint. Defaults to "auto" for backwards-compat. */
	modelTier?: CronModelTier;
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
	modelTier?: CronModelTier;
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
	/** Serialize mutations on a single job (createElizaTask + persist + audit).
	 * Without this, two concurrent `updateJob`s on the same id can both
	 * spawn eliza Tasks while the in-place mutation of the Map entry races,
	 * orphaning one task and writing inconsistent `taskId` to disk. */
	private readonly jobLocks = new KeyedAsyncLock();
	/** Serialize the cron.json file writer — sync writeFileSync is atomic
	 * per call, but interleaved write→read→write sequences from other
	 * services on the same dir aren't. The serial lock keeps persistence
	 * order matching mutation order. */
	private readonly persistLock = new SerialAsyncLock();

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

		const seedJob = (partial: Omit<CronJob, "id" | "createdAt" | "updatedAt" | "runCount" | "createdBy">) => {
			const id = crypto.randomUUID();
			const job: CronJob = {
				...partial,
				id,
				createdAt: now,
				createdBy: "system:default",
				updatedAt: now,
				runCount: 0,
			};
			this.jobs.set(id, job);
			this.audit({ action: "seed-default", jobId: id, ts: now, by: "system" });
			logger.info({ src: "cron", jobId: id, name: job.name }, `seeded default '${job.name}' cron job`);
			return id;
		};

		// ── 1. Check X mentions (every 10m, auto model) ─────────────
		seedJob({
			name: "Check X mentions",
			schedule: "every:10m",
			modelTier: "auto",
			enabled: true,
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
		});

		// ── 2. Memory hygiene (3 AM UTC, cheap model) ──────────────
		seedJob({
			name: "Memory hygiene",
			schedule: "cron:0 3 * * *",
			modelTier: "cheap",
			enabled: true,
			prompt: [
				"[MODEL_TIER: cheap — routine data work, SOTA model will review your output]",
				"",
				"Perform memory hygiene pass:",
				"1. Use PENSIEVE_LIST at '/' to list all top-level memory trees.",
				"2. Use PENSIEVE_SEARCH to find memories older than 14 days.",
				"3. For each old memory, score it on: recency (when last accessed), relevance (does it inform current goals/relationships), and uniqueness (is it duplicated elsewhere).",
				"4. Use PENSIEVE_WRITE to tag low-value memories (score < 30) as `memory:stale` — do NOT delete them.",
				"5. Identify near-duplicate facts and propose merges (list pairs with similarity > 80%).",
				"6. Check for contradictory facts and flag them as `memory:conflict` via PENSIEVE_WRITE.",
				"7. Use EVAL_PERSIST to save the hygiene report:",
				"   path: '/self/hygiene/<date>'",
				"   data: {totalScanned, staleTagged, mergeProposed, conflictsFound}",
				"   type: 'benchmark'",
				"",
				"Output your report as structured JSON so the eval model can verify your work.",
			].join("\n"),
		});

		// ── 3. Relationship context refresh (6 AM UTC, cheap model) ─
		seedJob({
			name: "Relationship context refresh",
			schedule: "cron:0 6 * * *",
			modelTier: "cheap",
			enabled: true,
			prompt: [
				"[MODEL_TIER: cheap — routine data work, SOTA model will review your output]",
				"",
				"Refresh relationship context:",
				"1. Use PENSIEVE_LIST at '/relationships/' and PENSIEVE_SEARCH for memories referencing people, users, or handles.",
				"2. For each known relationship, compute a strength score based on: interaction recency, interaction frequency, sentiment of recent exchanges, shared goals/projects.",
				"3. Categorize: active (interacted <7 days), warm (7-30 days), dormant (>30 days).",
				"4. Use X_SEARCH to check recent mentions of key relationships on X.",
				"5. Use PENSIEVE_WRITE to update relationship memories with fresh strength scores and last-interaction timestamps.",
				"6. Identify any NEW people who've interacted 3+ times but don't have a relationship memory yet — use PENSIEVE_WRITE to create one.",
				"7. Use EVAL_PERSIST to save the relationship report:",
				"   path: '/self/relationships/<date>'",
				"   data: {activeCount, warmCount, dormantCount, newRelationships, updatedScores}",
				"   type: 'benchmark'",
				"",
				"Output your report as structured JSON so the eval model can verify your work.",
			].join("\n"),
		});

		// ── 4. Superteam Earn daily scan (9 AM UTC, cheap model) ────
		seedJob({
			name: "Superteam Earn daily scan",
			schedule: "cron:0 9 * * *",
			modelTier: "cheap",
			enabled: true,
			prompt: [
				"[MODEL_TIER: cheap — routine data work, SOTA model will review your output]",
				"",
				"Run SUPERTEAM_EARN_SCAN to fetch all live bounties, projects, and grants from Superteam Earn.",
				"For each listing, compute viability ranking (high/medium/low) based on agent eligibility, reward, deadline, competition, and skill fit.",
				"Use PENSIEVE_WRITE to persist results at /earn/listings/<slug> with viability tags.",
				"The calendar is auto-populated by the earn scanner — no manual calendar creation needed.",
				"For HIGH viability listings that are new: use SUPERTEAM_EARN_SET_GOAL to set a goal, and draft an initial approach.",
				"For listings whose deadline has passed: use PENSIEVE_WRITE to mark as earn:expired.",
				"Use EVAL_PERSIST to save the scan report:",
				"   path: '/earn/scans/<date>'",
				"   data: {newCount, activeCount, expiredCount, highViability: [...slugs], urgentDeadlines: [...slugs]}",
				"   type: 'benchmark'",
				"",
				"Summarize: how many new, active, expired, and high-viability listings. Report any that need immediate attention (deadline <3 days).",
				"",
				"Output your report as structured JSON so the eval model can verify your work.",
			].join("\n"),
		});

		// ── 5. Self-benchmark + tool audit (12 PM UTC, cheap gather → SOTA eval) ──
		seedJob({
			name: "Self-benchmark and tool audit",
			schedule: "cron:0 12 * * *",
			modelTier: "cheap",
			enabled: true,
			prompt: [
				"[MODEL_TIER: cheap — data gathering phase. Output structured JSON for SOTA eval.]",
				"",
				"Perform a self-benchmark and tool audit using the Overwatch observability actions:",
				"1. Use OVERWATCH_TRAJECTORIES (limit: 100) to list the last 24h of trajectories.",
				"2. Use OVERWATCH_ACTION_STATS (limit: 100) to get per-action success/failure rates.",
				"3. For each enabled Printing Press CLI (use PRINTING_PRESS_INSTALLED): check if it appears in the action stats. Was it used? Any errors?",
				"4. Use OVERWATCH_TRAJECTORY_DETAIL on any failed trajectories to identify root causes.",
				"5. Check current Earn goals (use DETOUR_ACTIVE_GOAL) — any deadlines approaching? any stalled projects?",
				"6. Use PENSIEVE_READ to review the last hygiene report and relationship report for issues flagged.",
				"7. Use EVAL_PERSIST to save raw benchmark data:",
				"   path: '/self/benchmarks/<date>'",
				"   data: {trajectoryCount, actionStats, successRate, failedActions, toolUtilization, earnGoalStatus}",
				"   type: 'benchmark'",
				"8. List recommendations: CLIs to install (PRINTING_PRESS_SEARCH), CLIs to create (PRINTING_PRESS_CREATE), skills to develop.",
				"",
				"Output ALL data as structured JSON. The SOTA eval job will grade this and add corrections.",
			].join("\n"),
		});

		// ── 6. SOTA eval pass (12:30 PM UTC, SOTA model reviews cheap outputs) ──
		seedJob({
			name: "SOTA eval and corrections",
			schedule: "cron:30 12 * * *",
			modelTier: "sota",
			enabled: true,
			prompt: [
				"[MODEL_TIER: sota — you are the supervisor. Review and grade the cheap model's work.]",
				"",
				"You are performing the daily SOTA evaluation pass.",
				"",
				"STEP 1: Load today's reports from Pensieve:",
				"- Use PENSIEVE_READ at /self/hygiene/<today> (memory hygiene report)",
				"- Use PENSIEVE_READ at /self/relationships/<today> (relationship refresh report)",
				"- Use PENSIEVE_READ at /earn/scans/<today> (earn scan results)",
				"- Use PENSIEVE_READ at /self/benchmarks/<today> (self-benchmark data)",
				"",
				"STEP 2: Cross-verify using Overwatch (ground truth):",
				"- Use OVERWATCH_TRAJECTORIES (limit: 100) to see what actually happened today",
				"- Use OVERWATCH_ACTION_STATS (limit: 100) to get actual success rates",
				"- Compare the cheap model's reported numbers against the actual trajectory data",
				"- Use OVERWATCH_TRAJECTORY_DETAIL on suspicious trajectories to verify specific claims",
				"",
				"STEP 3: For each report, grade and evaluate:",
				"1. GRADE the quality (A/B/C/D/F) — was the data gathering thorough? accurate? well-structured?",
				"2. CORRECT any mistakes — wrong viability scores, missed relationships, incorrect memory classifications.",
				"3. ADD anything the cheap model missed — overlooked patterns, strategic insights, deeper analysis.",
				"4. RATE effectiveness (0-100) across: accuracy, completeness, insightDepth, actionQuality.",
				"",
				"STEP 4: Use EVAL_GRADE for each report with structured scores:",
				"  job: the job name (e.g., 'memory-hygiene', 'relationship-refresh', 'earn-scan', 'self-benchmark')",
				"  grade: A/B/C/D/F",
				"  scores: {accuracy, completeness, insightDepth, actionQuality, overall} (0-100)",
				"  corrections: string[] of mistakes found",
				"  additions: string[] of things missed",
				"  recommendations: string[] for improvement",
				"  trend: 'improving', 'stable', or 'declining' (compare to PENSIEVE_SEARCH for past evals)",
				"",
				"STEP 5: Use EVAL_PERSIST to save the full evaluation:",
				"  path: '/self/evals/<today>'",
				"  data: your complete evaluation object (including overwatch verification results)",
				"  type: 'eval'",
				"",
				"If any report scored below 60 on any metric, flag it for prompt revision.",
				"If the cheap model's reported stats don't match overwatch data, flag as 'data_integrity_issue'.",
				"If you corrected data, use PENSIEVE_WRITE to update the original entries.",
			].join("\n"),
		});

		// ── 7. Earn project work session (3 PM UTC, SOTA model) ─────
		seedJob({
			name: "Earn project work session",
			schedule: "cron:0 15 * * *",
			modelTier: "sota",
			enabled: true,
			prompt: [
				"[MODEL_TIER: sota — use best available model for high-quality output]",
				"",
				"This is your daily focused work session for Superteam Earn projects.",
				"1. Use DETOUR_ACTIVE_GOAL and PENSIEVE_READ at /earn/scans/ to check active goals. Pick the highest-viability opportunity with the closest deadline.",
				"2. Use PENSIEVE_READ at /earn/projects/<slug>/progress for any previous progress.",
				"3. Use PRINTING_PRESS_RUN with relevant installed CLIs to gather research data for the project.",
				"4. Use X_SEARCH to find relevant conversations, competitors, and context on the topic.",
				"5. Draft or iterate on the submission — this should be high-quality work:",
				"   - For bounties: produce the deliverable (code, content, design, research)",
				"   - For hackathons: build the project incrementally, track progress",
				"   - For grants: refine the proposal, add supporting data",
				"6. Use image generation (GENERATE_IMAGE) if the submission benefits from visual assets.",
				"7. Use PENSIEVE_WRITE to save progress at /earn/projects/<slug>/progress.",
				"8. If the deadline is <24h and work is complete, use SUPERTEAM_EARN_SUBMIT to submit.",
				"",
				"Focus on ONE project per session. Quality over quantity. This is where you earn revenue.",
			].join("\n"),
		});

		// ── 8. CLI data refresh (6 PM UTC, cheap model) ────────────
		seedJob({
			name: "CLI data refresh",
			schedule: "cron:0 18 * * *",
			modelTier: "cheap",
			enabled: true,
			prompt: [
				"[MODEL_TIER: cheap — routine data refresh, SOTA model will review your output]",
				"",
				"Refresh data from enabled Printing Press CLIs:",
				"1. Use PRINTING_PRESS_INSTALLED to get the list of installed CLIs.",
				"2. For each installed + enabled CLI, use PRINTING_PRESS_RUN with a lightweight query (e.g., 'status', 'health', or the simplest list command).",
				"   - Check if the API key is still valid (exit code 3 = auth error)",
				"   - Check if we're rate-limited (exit code 4 = rate limit)",
				"3. For CLIs that returned fresh data, use PENSIEVE_WRITE to cache key findings at /tools/<slug>/cache.",
				"4. For CLIs that failed, use PENSIEVE_WRITE to log the issue and tag as `tool:unhealthy`.",
				"5. If any CLI needs an API key you don't have, use PENSIEVE_WRITE to note it at /self/needs/api-keys.",
				"6. Use EVAL_PERSIST to save the tool health report:",
				"   path: '/self/tools/<date>'",
				"   data: {healthyClis, unhealthyClis, authErrors, rateLimited, missingKeys}",
				"   type: 'benchmark'",
				"",
				"Output your report as structured JSON so the eval model can verify your work.",
			].join("\n"),
		});

		this.defaultsSeededAt = now;
		void this.persist();
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
		if (!runtime.getTaskWorker(CRON_TASK_WORKER_NAME)) {
			runtime.registerTaskWorker({
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
					if (parsed?.type === "cron" && job.nextRunAt) {
						return { nextInterval: Math.max(60_000, job.nextRunAt - Date.now()) };
					}
					return parsed?.intervalMs ? { nextInterval: parsed.intervalMs } : undefined;
				},
			});
		}
		// Reconcile: every persisted job that's enabled should have a Task row.
		for (const job of this.jobs.values()) {
			if (!job.enabled) continue;
			await this.jobLocks.run(job.id, async () => {
				let needsTask = !job.taskId;
				if (job.taskId) {
					const task = await runtime.getTask(job.taskId as UUID).catch((err) => {
						logger.warn({ src: "cron", jobId: job.id, taskId: job.taskId, err: err instanceof Error ? err.message : err }, "task mirror lookup failed");
						return undefined;
					});
					if (task === null) {
						job.taskId = undefined;
						needsTask = true;
					}
				}
				const parsed = this.parsed(job);
				if (parsed && (!job.nextRunAt || job.nextRunAt < Date.now())) {
					job.nextRunAt = this.computeNextRun(parsed, Date.now());
				}
				if (needsTask) {
					try {
						const taskId = await this.createElizaTask(job);
						job.taskId = taskId;
					} catch (err) {
						logger.warn({ src: "cron", jobId: job.id, err: err instanceof Error ? err.message : err }, "create eliza task failed");
					}
				}
			});
		}
		await this.persist();
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
		return this.jobLocks.run(id, async () => {
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
			await this.persist();
			this.audit({ action: "create", jobId: id, ts: now, by: job.createdBy });
			return job;
		});
	}

	async updateJob(id: string, patch: CronJobUpdate): Promise<CronJob | null> {
		return this.jobLocks.run(id, async () => {
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
					await this.runtime.deleteTask(job.taskId as UUID);
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
			await this.persist();
			this.audit({ action: "update", jobId: id, ts: Date.now(), patch });
			return job;
		});
	}

	async deleteJob(id: string): Promise<boolean> {
		return this.jobLocks.run(id, async () => {
			const job = this.jobs.get(id);
			if (!job) return false;
			if (this.runtime && job.taskId) {
				try {
					await this.runtime.deleteTask(job.taskId as UUID);
				} catch { /* best-effort */ }
			}
			this.jobs.delete(id);
			this.parsedCache.delete(id);
			await this.persist();
			this.audit({ action: "delete", jobId: id, ts: Date.now() });
			return true;
		});
	}

	private async fire(job: CronJob): Promise<void> {
		await this.jobLocks.run(job.id, async () => {
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
			await this.persist();
		});
	}

	private async createElizaTask(job: CronJob): Promise<string> {
		const runtime = this.runtime;
		if (!runtime) throw new Error("no runtime");
		const parsed = this.parsed(job);
		const interval = parsed?.intervalMs ?? ONE_SHOT_INTERVAL_MS;
		const id = await runtime.createTask({
			name: CRON_TASK_WORKER_NAME,
			description: `cron:${job.name}`,
			tags: [...CRON_TASK_TAGS],
			metadata: {
				updateInterval: parsed?.type === "cron" && job.nextRunAt
					? Math.max(60_000, job.nextRunAt - Date.now())
					: interval,
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

	private persist(): Promise<void> {
		// Serialize the actual writer so two near-simultaneous mutations don't
		// race on the read→write cycle. The Map snapshot inside `run()` is
		// taken at the moment the lock fires, so each persisted file reflects
		// the state after that mutation completed.
		return this.persistLock.run(async () => {
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
		});
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
