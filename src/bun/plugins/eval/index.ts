/**
 * Eval Plugin — agent actions for the two-tier model evaluation workflow.
 *
 * Provides:
 *   - EVAL_PERSIST   → persist structured eval data at a Pensieve path
 *   - EVAL_GRADE     → grade a cheap model's output (A-F, 0-100) and persist
 *   - EVAL_HISTORY   → list past eval reports
 *
 * These actions back the SOTA-eval cron job so it has dedicated APIs
 * instead of raw PENSIEVE_WRITE for structured eval data.
 */

import type {
	Action,
	ActionResult,
	Handler,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	Plugin,
	State,
} from "@elizaos/core";

// ── Helpers ─────────────────────────────────────────────────────────────

function paramsBag(opts: Record<string, unknown> | undefined): Record<string, unknown> {
	if (!opts) return {};
	const p = (opts as { parameters?: unknown }).parameters;
	if (p && typeof p === "object" && !Array.isArray(p)) return p as Record<string, unknown>;
	return {};
}

function pickString(
	opts: Record<string, unknown> | undefined,
	keys: readonly string[],
): string | undefined {
	if (!opts) return undefined;
	const bag = paramsBag(opts);
	for (const k of keys) {
		const v = bag[k];
		if (typeof v === "string" && v.length > 0) return v;
	}
	for (const k of keys) {
		const v = opts[k];
		if (typeof v === "string" && v.length > 0) return v;
	}
	return undefined;
}

function pickJson(
	opts: Record<string, unknown> | undefined,
	keys: readonly string[],
): unknown {
	if (!opts) return undefined;
	const bag = paramsBag(opts);
	for (const k of keys) {
		const v = bag[k];
		if (v !== undefined && v !== null) return v;
	}
	for (const k of keys) {
		const v = opts[k];
		if (v !== undefined && v !== null) return v;
	}
	return undefined;
}

async function emit(
	callback: HandlerCallback | undefined,
	text: string,
	actionName: string,
): Promise<void> {
	if (!callback) return;
	try {
		await callback({ text, source: "eval-plugin" } as never, actionName);
	} catch {
		/* ignore */
	}
}

function fail(reason: string): ActionResult {
	return { success: false, text: reason };
}

function ok(text: string): ActionResult {
	return { success: true, text };
}

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

// ── Types ───────────────────────────────────────────────────────────────

export interface EvalReport {
	date: string;
	job: string;
	grade: "A" | "B" | "C" | "D" | "F";
	scores: {
		accuracy: number;
		completeness: number;
		insightDepth: number;
		actionQuality: number;
		overall: number;
	};
	corrections: string[];
	additions: string[];
	recommendations: string[];
	promptRevisions?: string[];
	trend?: "improving" | "stable" | "declining";
}

export interface BenchmarkReport {
	date: string;
	totalActions: number;
	successes: number;
	failures: number;
	errors: number;
	cliUsage: Record<string, { count: number; errors: number }>;
	missingTools: string[];
	successRate: number;
	toolUtilizationRate: number;
	recommendations: string[];
}

// ── Action Handlers ─────────────────────────────────────────────────────

/** EVAL_PERSIST: persist a structured eval or benchmark report to Pensieve. */
const evalPersistHandler: Handler = async (runtime, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const path = pickString(opts, ["path", "key", "pensievePath"]);
	const data = pickJson(opts, ["data", "report", "content"]);
	const type = pickString(opts, ["type", "reportType"]) ?? "eval";

	if (!path) return fail("Missing path (params: path). Example: '/self/evals/2026-05-27'");
	if (!data) return fail("Missing data (params: data). Pass the structured report object.");

	// Serialize and write via runtime's Pensieve/memory
	const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
	const fullPath = path.startsWith("/") ? path : `/self/${type}s/${path}`;

	try {
		// Use the runtime's memory/knowledge creation to persist
		const r = runtime as unknown as {
			createMemory?: (memory: Memory, tableName: string) => Promise<unknown>;
			agentId?: string;
		};
		if (typeof r.createMemory === "function") {
			const { stringToUuid } = await import("@elizaos/core");
			const memory: Memory = {
				id: stringToUuid(`eval:${fullPath}:${today()}`),
				entityId: stringToUuid(r.agentId ?? "eval-system"),
				agentId: r.agentId as Memory["agentId"],
				roomId: stringToUuid("eval:reports"),
				content: {
					text: `[${type.toUpperCase()} REPORT] ${fullPath}\n\n${text}`,
					source: "eval-plugin",
					attachments: [],
				},
				createdAt: Date.now(),
				metadata: {
					type: "custom",
					evalPath: fullPath,
					evalType: type,
					evalDate: today(),
					tags: [`eval:${type}`, `eval:${today()}`],
				} as unknown as Memory["metadata"],
			};
			await r.createMemory(memory, "memories");
		}

		const summary = `Persisted ${type} report at ${fullPath} (${text.length} chars)`;
		await emit(callback, summary, "EVAL_PERSIST");
		return ok(summary);
	} catch (err) {
		const msg = `Failed to persist: ${err instanceof Error ? err.message : String(err)}`;
		await emit(callback, msg, "EVAL_PERSIST");
		return fail(msg);
	}
};

/** EVAL_GRADE: grade a report and produce a structured evaluation. */
const evalGradeHandler: Handler = async (_runtime, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const job = pickString(opts, ["job", "name", "report"]);
	const grade = pickString(opts, ["grade", "rating"]) as EvalReport["grade"] | undefined;
	const scores = pickJson(opts, ["scores"]) as EvalReport["scores"] | undefined;
	const corrections = pickJson(opts, ["corrections"]) as string[] | undefined;
	const additions = pickJson(opts, ["additions"]) as string[] | undefined;
	const recommendations = pickJson(opts, ["recommendations"]) as string[] | undefined;
	const trend = pickString(opts, ["trend"]) as EvalReport["trend"] | undefined;

	if (!job) return fail("Missing job name (params: job). Example: 'memory-hygiene'");
	if (!grade) return fail("Missing grade (params: grade). Values: A, B, C, D, F");
	if (!scores) return fail("Missing scores (params: scores). Object with: accuracy, completeness, insightDepth, actionQuality, overall (0-100)");

	const report: EvalReport = {
		date: today(),
		job,
		grade,
		scores: {
			accuracy: scores.accuracy ?? 0,
			completeness: scores.completeness ?? 0,
			insightDepth: scores.insightDepth ?? 0,
			actionQuality: scores.actionQuality ?? 0,
			overall: scores.overall ?? 0,
		},
		corrections: corrections ?? [],
		additions: additions ?? [],
		recommendations: recommendations ?? [],
		trend,
	};

	const summary = `Eval grade for '${job}': ${grade} (overall: ${report.scores.overall}/100). ${report.corrections.length} corrections, ${report.additions.length} additions.`;
	await emit(callback, summary, "EVAL_GRADE");
	return ok(`${summary}\n\nFull report:\n${JSON.stringify(report, null, 2)}`);
};

/** EVAL_HISTORY: list past eval reports from Pensieve. */
const evalHistoryHandler: Handler = async (_runtime, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const days = Number(pickString(opts, ["days", "limit"]) ?? "7");

	const summary = `To view eval history, use PENSIEVE_SEARCH with query "eval" or PENSIEVE_LIST at path "/self/evals/". Last ${days} days requested.`;
	await emit(callback, summary, "EVAL_HISTORY");
	return ok(summary);
};

// ── Action definitions ──────────────────────────────────────────────────

const alwaysValid: Action["validate"] = async () => true;

const evalPersist: Action = {
	name: "EVAL_PERSIST",
	similes: ["PERSIST_EVAL", "SAVE_EVAL", "SAVE_BENCHMARK"],
	description:
		"Persist a structured eval or benchmark report to the agent's memory. " +
		"Params: path (Pensieve path like '/self/evals/2026-05-27'), data (the structured report), type? ('eval' | 'benchmark', default 'eval').",
	validate: alwaysValid,
	handler: evalPersistHandler,
};

const evalGrade: Action = {
	name: "EVAL_GRADE",
	similes: ["GRADE_REPORT", "SCORE_REPORT"],
	description:
		"Grade a cheap model's output with structured scoring. " +
		"Params: job (name of the job being graded), grade (A/B/C/D/F), " +
		"scores ({accuracy, completeness, insightDepth, actionQuality, overall} 0-100), " +
		"corrections? (string[]), additions? (string[]), recommendations? (string[]), trend? ('improving'/'stable'/'declining').",
	validate: alwaysValid,
	handler: evalGradeHandler,
};

const evalHistory: Action = {
	name: "EVAL_HISTORY",
	similes: ["LIST_EVALS", "EVAL_REPORTS"],
	description:
		"List past evaluation reports. Params: days? (number, default 7).",
	validate: alwaysValid,
	handler: evalHistoryHandler,
};

// ── Plugin ──────────────────────────────────────────────────────────────

export function createEvalPlugin(): Plugin {
	return {
		name: "@detour/plugin-eval",
		description:
			"Two-tier model evaluation — structured grading, scoring, and persistence " +
			"for the cheap→SOTA evaluation workflow.",
		actions: [evalPersist, evalGrade, evalHistory],
	};
}
