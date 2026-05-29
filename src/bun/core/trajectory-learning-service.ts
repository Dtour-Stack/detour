/**
 * Phase 2 — learn-over-trajectories loop.
 *
 * Periodically reads recent trajectories the agent hasn't learned from yet
 * (`used_in_training = false`), each carrying a real reward signal, and distills
 * them into a BOUNDED, update-in-place "lessons" artifact (overwritten each
 * cycle — never appended, so it can't re-bloat the store the way per-cycle
 * memory rows would). The lessons are surfaced back into the agent's context by
 * `trajectory-lessons-provider`, closing the self-improvement loop. After a
 * cycle the processed trajectories are marked learned, which also makes them
 * eligible for Phase 1 retention pruning.
 *
 * Bounded by design: one file, capped length, merged-not-appended.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger, ModelType, type IAgentRuntime } from "@elizaos/core";
import type { RuntimeService } from "./runtime";
import type { ActivityTrajectoryService, TrajectoryLearningRow } from "./activity/trajectory-service";

const LESSONS_DIR = join(homedir(), ".detour");
const LESSONS_PATH = join(LESSONS_DIR, "trajectory-lessons.md");
const DEFAULT_INTERVAL_MS = 30 * 60_000;
const MIN_TRAJECTORIES = 5;
const BATCH = 40;
const MAX_LESSONS_CHARS = 4000;

type Deps = {
	runtime: Pick<RuntimeService, "peek">;
	trajectories: Pick<ActivityTrajectoryService, "listForLearning" | "markLearned">;
	intervalMs?: number;
};

export class TrajectoryLearningService {
	private timer: ReturnType<typeof setInterval> | null = null;
	private readonly intervalMs: number;

	constructor(private readonly deps: Deps) {
		this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.tick().catch((err) => logger.warn({ src: "trajectory-learning", err: err instanceof Error ? err.message : err }, "tick failed"));
		}, this.intervalMs);
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	/** Latest distilled lessons, for the provider that injects them into context. */
	static readLessons(): string | null {
		try {
			return existsSync(LESSONS_PATH) ? readFileSync(LESSONS_PATH, "utf8").trim() || null : null;
		} catch {
			return null;
		}
	}

	async tick(): Promise<{ processed: number; marked: number; wrote: boolean } | null> {
		const runtime = this.deps.runtime.peek();
		if (!runtime) return null;
		if (!booleanSetting(runtime, "DETOUR_TRAJECTORY_LEARNING_ENABLED", true)) return null;
		const rows = await this.deps.trajectories.listForLearning(BATCH);
		if (rows.length < MIN_TRAJECTORIES) return null;
		const lessons = await this.distill(runtime, rows);
		const wrote = lessons ? this.writeLessons(lessons) : false;
		// Mark processed regardless of distill success so they don't pile up
		// un-learnable; the reward signal is preserved in the archive.
		const marked = await this.deps.trajectories.markLearned(rows.map((r) => r.id));
		logger.info({ src: "trajectory-learning", processed: rows.length, marked, wrote }, "trajectory learning cycle complete");
		return { processed: rows.length, marked, wrote };
	}

	private async distill(runtime: IAgentRuntime, rows: TrajectoryLearningRow[]): Promise<string | null> {
		const sorted = [...rows].sort((a, b) => b.totalReward - a.totalReward);
		const fmt = (r: TrajectoryLearningRow) =>
			`- source=${r.source} status=${r.status} reward=${r.totalReward}${r.aiJudgeReasoning ? ` judge="${r.aiJudgeReasoning.slice(0, 160)}"` : ""}`;
		const wins = sorted.filter((r) => r.totalReward > 0).slice(0, 8);
		const fails = sorted.filter((r) => r.totalReward <= 0).slice(-8);
		const prior = TrajectoryLearningService.readLessons() ?? "(none yet)";
		const prompt = [
			"You are improving the Detour Squirrel agent by learning from its own recent action trajectories. Each carries a reward (higher = better outcome).",
			"",
			"HIGH-REWARD trajectories (patterns that worked — reinforce):",
			...(wins.length ? wins.map(fmt) : ["(none this batch)"]),
			"",
			"LOW/NEGATIVE-REWARD trajectories (patterns that misfired — correct):",
			...(fails.length ? fails.map(fmt) : ["(none this batch)"]),
			"",
			"Prior lessons (EVOLVE these — merge, drop stale points, do not just append):",
			prior,
			"",
			"Output an updated lessons doc in markdown, UNDER 1200 characters, with exactly these sections:",
			"## Patterns to repeat",
			"## Patterns to avoid",
			"## Skill adjustments",
			"Be concrete and concise. This doc is injected into the agent's context every turn, so keep it tight and bounded.",
		].join("\n");
		try {
			const out = await runtime.useModel(ModelType.TEXT_LARGE, { prompt, maxTokens: 600 });
			const text = typeof out === "string" ? out.trim() : "";
			return text.length > 0 ? text.slice(0, MAX_LESSONS_CHARS) : null;
		} catch (err) {
			logger.warn({ src: "trajectory-learning", err: err instanceof Error ? err.message : err }, "distill model call failed");
			return null;
		}
	}

	private writeLessons(text: string): boolean {
		try {
			if (!existsSync(LESSONS_DIR)) mkdirSync(LESSONS_DIR, { recursive: true });
			writeFileSync(LESSONS_PATH, `<!-- Detour trajectory lessons — auto-distilled, update-in-place -->\n\n${text}\n`, "utf8");
			return true;
		} catch (err) {
			logger.warn({ src: "trajectory-learning", err: err instanceof Error ? err.message : err }, "write lessons failed");
			return false;
		}
	}
}

function booleanSetting(runtime: IAgentRuntime, key: string, dflt: boolean): boolean {
	const fromRuntime = typeof runtime.getSetting === "function" ? runtime.getSetting(key) : undefined;
	const v = typeof fromRuntime === "string" && fromRuntime.length > 0 ? fromRuntime : process.env[key];
	if (typeof v !== "string" || v.length === 0) return dflt;
	return !["0", "false", "no", "off"].includes(v.trim().toLowerCase());
}
