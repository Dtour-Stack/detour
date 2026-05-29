/**
 * X persona Phase 2 -- engagement feedback loop.
 *
 * Background core service (setInterval, NOT cron). Once a day it reads the
 * agent's OWN recent posts, ranks them by conversation-weighted engagement, and
 * writes a short markdown lesson ("what landed" / "what flopped") to its OWN
 * file ~/.detour/x-feedback-lessons.md. It deliberately does NOT touch the
 * separate single-writer trajectory lessons artifact owned by
 * TrajectoryLearningService.
 *
 * Import discipline: @elizaos/core and the x-tweets pure leaf modules
 * (feedback) plus the x-client ONLY. Never the core barrel (./index) or a
 * plugin barrel. The runtime accessor is typed structurally so there is no edge
 * to ./runtime.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger, type IAgentRuntime } from "@elizaos/core";
import { XClient } from "../plugins/x-tweets/x-client";
import { summarizeEngagement, type PostEngagement } from "../plugins/x-tweets/feedback";

const DEFAULT_INTERVAL_MS = 24 * 60 * 60_000;
const LESSONS_DIR = join(homedir(), ".detour");
const LESSONS_PATH = join(LESSONS_DIR, "x-feedback-lessons.md");
const SAMPLE_COUNT = 20;

type RuntimeAccessor = { peek(): IAgentRuntime | null };

type Deps = {
	runtime: RuntimeAccessor;
	intervalMs?: number;
};

export class XFeedbackService {
	private timer: ReturnType<typeof setInterval> | null = null;
	private readonly intervalMs: number;

	constructor(private readonly deps: Deps) {
		this.intervalMs = resolveInterval(deps.runtime, "X_FEEDBACK_INTERVAL_MS", deps.intervalMs, DEFAULT_INTERVAL_MS);
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.tick();
		}, this.intervalMs);
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	/** Fail-safe by contract: any X / fs failure is logged and swallowed. This
	 *  never rejects. */
	async tick(): Promise<{ wrote: boolean } | null> {
		try {
			const runtime = this.deps.runtime.peek();
			if (!runtime) return null;

			const client = buildXClient(runtime);
			if (!client) return { wrote: false }; // X creds absent: skip gracefully

			const viewer = await client.viewer();
			if (!viewer.userId) return { wrote: false };
			const tweets = await client.getUserTweets(viewer.userId, SAMPLE_COUNT);

			const posts: PostEngagement[] = tweets.map((t) => ({
				text: t.text,
				replyCount: t.replyCount ?? 0,
				retweetCount: t.retweetCount ?? 0,
				favoriteCount: t.favoriteCount ?? 0,
			}));
			if (posts.length === 0) return { wrote: false };

			const summary = summarizeEngagement(posts);
			const wrote = this.writeLessons(summary.topPatterns, summary.flops);
			logger.info({ src: "x-feedback", posts: posts.length, wrote }, "x engagement feedback refreshed");
			return { wrote };
		} catch (err) {
			logger.warn({ src: "x-feedback", err: err instanceof Error ? err.message : err }, "tick failed");
			return null;
		}
	}

	private writeLessons(topPatterns: string[], flops: string[]): boolean {
		try {
			if (!existsSync(LESSONS_DIR)) mkdirSync(LESSONS_DIR, { recursive: true });
			const fmt = (lines: string[]) => (lines.length > 0 ? lines.map((l) => `- ${oneLine(l)}`).join("\n") : "- (nothing this cycle)");
			const doc = [
				"<!-- Detour X engagement feedback -- auto-distilled, update-in-place -->",
				"",
				"# What landed",
				fmt(topPatterns),
				"",
				"# What flopped",
				fmt(flops),
				"",
			].join("\n");
			writeFileSync(LESSONS_PATH, doc, "utf8");
			return true;
		} catch (err) {
			logger.warn({ src: "x-feedback", err: err instanceof Error ? err.message : err }, "write lessons failed");
			return false;
		}
	}
}

/** Collapse a post body to a single bounded line for the lesson list. */
function oneLine(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > 160 ? `${flat.slice(0, 157)}...` : flat;
}

/** Construct an XClient from runtime settings, or null when cookies are absent.
 *  XClient's constructor throws on empty cookies, so we guard before building. */
function buildXClient(runtime: IAgentRuntime): XClient | null {
	const authToken = (runtime.getSetting?.("X_AUTH_TOKEN") ?? "").toString().trim();
	const ct0 = (runtime.getSetting?.("X_CT0") ?? "").toString().trim();
	if (!authToken || !ct0) return null;
	const userAgent = (runtime.getSetting?.("X_USER_AGENT") ?? "").toString().trim();
	return new XClient({ cookies: { authToken, ct0 }, ...(userAgent ? { userAgent } : {}) });
}

function resolveInterval(runtime: RuntimeAccessor, key: string, override: number | undefined, dflt: number): number {
	if (typeof override === "number" && override > 0) return override;
	try {
		// At boot the runtime is not built yet (peek() is null), so fall back to
		// process.env -- config.bootstrap() mirrors these settings there before
		// services are constructed (these keys are mirrorToEnv).
		const raw = runtime.peek()?.getSetting?.(key) ?? process.env[key];
		const n = typeof raw === "string" ? Number(raw) : Number.NaN;
		if (Number.isFinite(n) && n > 0) return n;
	} catch {
		// fall through to default
	}
	return dflt;
}
