/**
 * X persona Phase 2 -- "what is happening now" radar.
 *
 * Background core service (setInterval, NOT cron -- cron would fire LLM agent
 * turns). Periodically pulls a few live facts per seed query from Tavily, folds
 * them into a bounded radar digest, and writes ONE update-in-place Pensieve
 * memory at /x/radar/latest. The persona surfaces this so the agent knows the
 * current news landscape without spinning up an agent turn per refresh.
 *
 * Import discipline: this module may import @elizaos/core, the x-tweets pure
 * leaf modules (research, radar), and ./pensieve/memory-service ONLY. It must
 * never import the core barrel (./index) or any plugin barrel -- that would
 * close an import cycle. The runtime accessor is typed structurally so there is
 * no edge to ./runtime either.
 */
import { logger, type IAgentRuntime } from "@elizaos/core";
import { buildRadarDigest, type RadarItem } from "../plugins/x-tweets/radar";
import { buildResearchContext } from "../plugins/x-tweets/research";
import type { PensieveMemoryService } from "./pensieve/memory-service";

const DEFAULT_INTERVAL_MS = 45 * 60_000;

/** Seed queries the radar sweeps each cycle. Kept short and broad so the digest
 *  stays a high-signal "current events" snapshot rather than a firehose. */
const SEED_QUERIES = ["top technology news today", "AI news today", "world news today"] as const;

type RuntimeAccessor = { peek(): IAgentRuntime | null };

type Deps = {
	runtime: RuntimeAccessor;
	memories: Pick<PensieveMemoryService, "create">;
	intervalMs?: number;
};

export class XRadarService {
	private timer: ReturnType<typeof setInterval> | null = null;
	private readonly intervalMs: number;

	constructor(private readonly deps: Deps) {
		this.intervalMs = resolveInterval(deps.runtime, "X_RADAR_INTERVAL_MS", deps.intervalMs, DEFAULT_INTERVAL_MS);
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

	/** Fail-safe by contract: any Tavily / model / Pensieve failure is logged and
	 *  swallowed. This never rejects, so a hiccup can't crash the service or app. */
	async tick(): Promise<{ wrote: boolean } | null> {
		try {
			const runtime = this.deps.runtime.peek();
			if (!runtime) return null;
			const key = (runtime.getSetting?.("TAVILY_API_KEY") ?? "").toString().trim();
			if (!key) return { wrote: false };

			const items: RadarItem[] = [];
			for (const query of SEED_QUERIES) {
				const context = await buildResearchContext(query, key);
				if (!context) continue;
				// buildResearchContext returns a multi-line "fact[i]: title | content"
				// block. Each fact line becomes one radar item titled by the query
				// (the digest dedups by title, so include the snippet for signal).
				for (const line of context.split("\n")) {
					const m = /^fact\[\d+\]:\s*(.*)$/.exec(line.trim());
					if (!m) continue;
					const [title, snippet] = m[1].split(" | ");
					items.push({ title: (title ?? query).trim() || query, snippet: snippet?.trim(), source: query });
				}
			}

			// X trends are not available: there is no getTrends() on XClient, so we
			// pass [] for trends. (Gap noted for a future X trends source.)
			const dateLabel = `As of ${new Date().toISOString().slice(0, 10)}:`;
			const digest = buildRadarDigest(items, [], { dateLabel });
			if (!digest.trim()) return { wrote: false };

			await this.deps.memories.create({
				text: digest,
				type: "current-events",
				tags: ["radar"],
				path: "/x/radar/latest",
			});
			logger.info({ src: "x-radar", items: items.length }, "x radar digest refreshed");
			return { wrote: true };
		} catch (err) {
			logger.warn({ src: "x-radar", err: err instanceof Error ? err.message : err }, "tick failed");
			return null;
		}
	}
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
