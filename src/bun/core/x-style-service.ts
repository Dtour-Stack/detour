/**
 * X persona Phase 2 -- style psyche miner.
 *
 * Background core service (setInterval, NOT cron). Once a day it reads a handful
 * of exemplar accounts, samples their recent tweets, asks the model to distill
 * REUSABLE CRAFT (never verbatim lines, never another account's identity), and
 * writes ONE update-in-place Pensieve memory at /x/style-psyche/latest that the
 * persona injects as a voice guide.
 *
 * Import discipline: @elizaos/core, the x-tweets pure leaf modules
 * (style-mining) plus the x-client, and ./pensieve/memory-service ONLY. Never
 * the core barrel (./index) or a plugin barrel. The runtime accessor is typed
 * structurally so there is no edge to ./runtime.
 */
import { logger, ModelType, type IAgentRuntime } from "@elizaos/core";
import { XClient } from "../plugins/x-tweets/x-client";
import { distillPsychePrompt, formatPsyche, type AccountSamples } from "../plugins/x-tweets/style-mining";
import type { PensieveMemoryService } from "./pensieve/memory-service";

const DEFAULT_INTERVAL_MS = 24 * 60 * 60_000;
const DEFAULT_EXEMPLARS = "dexploarer,shawmakesmagic,god,Satan";
const SAMPLES_PER_ACCOUNT = 15;

type RuntimeAccessor = { peek(): IAgentRuntime | null };

type Deps = {
	runtime: RuntimeAccessor;
	memories: Pick<PensieveMemoryService, "create">;
	intervalMs?: number;
};

export class XStyleService {
	private timer: ReturnType<typeof setInterval> | null = null;
	private readonly intervalMs: number;

	constructor(private readonly deps: Deps) {
		this.intervalMs = resolveInterval(deps.runtime, "X_STYLE_INTERVAL_MS", deps.intervalMs, DEFAULT_INTERVAL_MS);
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

	/** Fail-safe by contract: any X / model / Pensieve failure is logged and
	 *  swallowed. This never rejects. */
	async tick(): Promise<{ wrote: boolean } | null> {
		try {
			const runtime = this.deps.runtime.peek();
			if (!runtime) return null;

			const client = buildXClient(runtime);
			if (!client) return { wrote: false }; // X creds absent: skip gracefully

			const handles = (runtime.getSetting?.("X_STYLE_EXEMPLARS") ?? DEFAULT_EXEMPLARS)
				.toString()
				.split(",")
				.map((h) => h.trim())
				.filter((h) => h.length > 0);

			const samples: AccountSamples[] = [];
			for (const handle of handles) {
				try {
					const user = await client.getUserByScreenName(handle);
					if (!user || !user.userId) continue;
					const tweets = await client.getUserTweets(user.userId, SAMPLES_PER_ACCOUNT);
					samples.push({ handle, tweets: tweets.map((t) => t.text).filter((t) => t.length > 0) });
				} catch (err) {
					logger.warn({ src: "x-style", handle, err: err instanceof Error ? err.message : err }, "exemplar sample failed");
				}
			}

			if (samples.length === 0) return { wrote: false };

			const prompt = distillPsychePrompt(samples);
			const out = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
			const text = typeof out === "string" ? out : String(out ?? "");
			const psyche = formatPsyche(text);
			if (!psyche.trim()) return { wrote: false };

			await this.deps.memories.create({
				text: psyche,
				type: "style-psyche",
				tags: ["voice"],
				path: "/x/style-psyche/latest",
			});
			logger.info({ src: "x-style", accounts: samples.length }, "x style psyche refreshed");
			return { wrote: true };
		} catch (err) {
			logger.warn({ src: "x-style", err: err instanceof Error ? err.message : err }, "tick failed");
			return null;
		}
	}
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
