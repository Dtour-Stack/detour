/**
 * Overwatch Plugin — agent-side observability and self-evaluation actions.
 *
 * Gives the agent (especially the SOTA eval cron) the ability to:
 *   1. Prompt itself / send test messages and observe the result
 *   2. List and inspect trajectories (every LLM call, action, params, result)
 *   3. Read runtime logs and search for errors/patterns
 *   4. Inspect runtime state (registered actions, providers, plugins)
 *   5. Grade a trajectory's quality programmatically
 *   6. Run a test prompt and verify the output
 *
 * This is the agent's "mirror" — it can see exactly what it did, how it
 * did it, and evaluate whether it was correct. Think of it as the API
 * surface a training engineer would use to conduct an eval.
 */

import type {
	Action,
	ActionResult,
	Handler,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	State,
	Plugin,
	Provider,
	ProviderResult,
} from "@elizaos/core";

// ── Helpers ─────────────────────────────────────────────────────────────

function pick(
	opts: Record<string, unknown> | undefined,
	keys: readonly string[],
): string | undefined {
	if (!opts) return undefined;
	const bag = ((opts as { parameters?: unknown }).parameters ?? opts) as Record<string, unknown>;
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

function pickNum(
	opts: Record<string, unknown> | undefined,
	keys: readonly string[],
): number | undefined {
	if (!opts) return undefined;
	const bag = ((opts as { parameters?: unknown }).parameters ?? opts) as Record<string, unknown>;
	for (const k of keys) {
		const v = bag[k] ?? opts[k];
		if (typeof v === "number" && Number.isFinite(v)) return v;
		if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
	}
	return undefined;
}

async function emit(
	callback: HandlerCallback | undefined,
	text: string,
	actionName: string,
): Promise<void> {
	if (!callback) return;
	try { await callback({ text, source: "overwatch" } as never, actionName); } catch { /* */ }
}

function fail(reason: string): ActionResult { return { success: false, text: reason }; }
function ok(text: string): ActionResult { return { success: true, text }; }

// ── Trajectory access (duck-typed from runtime service) ─────────────

interface TrajectoriesShape {
	listTrajectories?: (opts: {
		limit?: number;
		offset?: number;
		status?: string;
		source?: string;
		q?: string;
	}) => Promise<{
		trajectories: Array<{
			id: string;
			source?: string;
			status?: string;
			startTime?: number;
			endTime?: number;
			durationMs?: number;
			llmCallCount?: number;
			totalPromptTokens?: number;
			totalCompletionTokens?: number;
		}>;
		total: number;
	}>;
	getTrajectoryDetail?: (id: string) => Promise<Record<string, unknown> | null>;
}

function findTrajectoryService(runtime: IAgentRuntime): TrajectoriesShape | null {
	const r = runtime as unknown as {
		getService?: (t: string) => unknown;
		getServicesByType?: (t: string) => unknown[];
	};
	const svc = r.getService?.("trajectories") ?? null;
	if (svc && typeof svc === "object" && typeof (svc as TrajectoriesShape).listTrajectories === "function") {
		return svc as TrajectoriesShape;
	}
	const all = r.getServicesByType?.("trajectories") ?? [];
	for (const s of all) {
		if (s && typeof s === "object" && typeof (s as TrajectoriesShape).listTrajectories === "function") {
			return s as TrajectoriesShape;
		}
	}
	return null;
}

// ── Flatten trajectory detail for agent consumption ─────────────────

function asStr(v: unknown): string | undefined { return typeof v === "string" ? v : undefined; }
function asNum(v: unknown): number | undefined { return typeof v === "number" && Number.isFinite(v) ? v : undefined; }
function asArr(v: unknown): unknown[] { return Array.isArray(v) ? v : []; }
function asObj(v: unknown): Record<string, unknown> | null {
	return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

interface FlatStep {
	step: number;
	reasoning?: string;
	actionName?: string;
	actionParams?: unknown;
	actionSuccess?: boolean;
	actionResult?: unknown;
	actionError?: string;
	llmModel?: string;
	llmPromptTokens?: number;
	llmCompletionTokens?: number;
	llmLatencyMs?: number;
}

function flattenTrajectory(raw: Record<string, unknown>): {
	id: string;
	source?: string;
	status?: string;
	startTime?: number;
	endTime?: number;
	durationMs?: number;
	stepCount: number;
	totalLlmCalls: number;
	totalActions: number;
	totalPromptTokens: number;
	totalCompletionTokens: number;
	steps: FlatStep[];
} {
	const steps = asArr(raw.steps);
	const flatSteps: FlatStep[] = [];
	let totalLlmCalls = 0;
	let totalActions = 0;
	let totalPromptTokens = 0;
	let totalCompletionTokens = 0;

	for (const stepRaw of steps) {
		const step = asObj(stepRaw);
		if (!step) continue;
		const stepNum = asNum(step.stepNumber) ?? flatSteps.length;

		// LLM calls
		const llmCalls = asArr(step.llmCalls);
		totalLlmCalls += llmCalls.length;
		const firstLlm = asObj(llmCalls[0]);

		for (const lc of llmCalls) {
			const call = asObj(lc);
			if (call) {
				totalPromptTokens += asNum(call.promptTokens) ?? 0;
				totalCompletionTokens += asNum(call.completionTokens) ?? 0;
			}
		}

		// Action
		const action = asObj(step.action);
		if (action && Object.keys(action).length > 0) totalActions++;

		flatSteps.push({
			step: stepNum,
			reasoning: asStr(step.reasoning),
			actionName: action ? asStr(action.actionName) ?? asStr(action.actionType) : undefined,
			actionParams: action?.parameters,
			actionSuccess: action ? (typeof action.success === "boolean" ? action.success : undefined) : undefined,
			actionResult: action?.result,
			actionError: action ? asStr(action.error) : undefined,
			llmModel: firstLlm ? asStr(firstLlm.model) : undefined,
			llmPromptTokens: firstLlm ? asNum(firstLlm.promptTokens) : undefined,
			llmCompletionTokens: firstLlm ? asNum(firstLlm.completionTokens) : undefined,
			llmLatencyMs: firstLlm ? asNum(firstLlm.latencyMs) : undefined,
		});
	}

	const metrics = asObj(raw.metrics);
	return {
		id: asStr(raw.trajectoryId) ?? asStr(raw.id) ?? "",
		source: asStr(raw.source),
		status: asStr(metrics?.finalStatus),
		startTime: asNum(raw.startTime),
		endTime: asNum(raw.endTime),
		durationMs: asNum(raw.durationMs),
		stepCount: steps.length,
		totalLlmCalls,
		totalActions,
		totalPromptTokens,
		totalCompletionTokens,
		steps: flatSteps,
	};
}

// ── Action Handlers ─────────────────────────────────────────────────────

/** OVERWATCH_TRAJECTORIES: list recent trajectories with summary stats. */
const listTrajectoriesHandler: Handler = async (runtime, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const limit = pickNum(opts, ["limit", "count"]) ?? 20;
	const status = pick(opts, ["status"]);
	const source = pick(opts, ["source"]);
	const query = pick(opts, ["q", "query", "search"]);

	const svc = findTrajectoryService(runtime);
	if (!svc?.listTrajectories) return fail("Trajectory service not available on this runtime.");

	const result = await svc.listTrajectories({ limit, status, source, q: query });
	const lines = [`Found ${result.total} trajectories (showing ${result.trajectories.length}):\n`];
	for (const t of result.trajectories) {
		const dur = t.durationMs ? `${(t.durationMs / 1000).toFixed(1)}s` : "?";
		const tokens = `${t.totalPromptTokens ?? 0}+${t.totalCompletionTokens ?? 0} tokens`;
		lines.push(`• ${t.id} | ${t.source ?? "?"} | ${t.status ?? "?"} | ${dur} | ${t.llmCallCount ?? 0} LLM calls | ${tokens}`);
	}
	const text = lines.join("\n");
	await emit(callback, text, "OVERWATCH_TRAJECTORIES");
	return ok(text);
};

/** OVERWATCH_TRAJECTORY_DETAIL: get full details of a specific trajectory. */
const trajectoryDetailHandler: Handler = async (runtime, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const id = pick(opts, ["id", "trajectoryId"]);
	if (!id) return fail("Missing trajectory id (params: id).");

	const svc = findTrajectoryService(runtime);
	if (!svc?.getTrajectoryDetail) return fail("Trajectory service not available.");

	const raw = await svc.getTrajectoryDetail(id);
	if (!raw) return fail(`Trajectory '${id}' not found.`);

	const detail = flattenTrajectory(raw);
	const lines: string[] = [];
	lines.push(`# Trajectory ${detail.id}`);
	lines.push(`Source: ${detail.source ?? "unknown"} | Status: ${detail.status ?? "unknown"}`);
	lines.push(`Duration: ${detail.durationMs ? `${(detail.durationMs / 1000).toFixed(1)}s` : "?"}`);
	lines.push(`Steps: ${detail.stepCount} | LLM calls: ${detail.totalLlmCalls} | Actions: ${detail.totalActions}`);
	lines.push(`Tokens: ${detail.totalPromptTokens} prompt + ${detail.totalCompletionTokens} completion`);
	lines.push("");

	for (const step of detail.steps) {
		lines.push(`## Step ${step.step}`);
		if (step.reasoning) lines.push(`Reasoning: ${step.reasoning.slice(0, 300)}`);
		if (step.llmModel) lines.push(`Model: ${step.llmModel} (${step.llmPromptTokens ?? 0}+${step.llmCompletionTokens ?? 0} tokens, ${step.llmLatencyMs ?? "?"}ms)`);
		if (step.actionName) {
			lines.push(`Action: ${step.actionName} → ${step.actionSuccess ? "✅" : "❌"}`);
			if (step.actionParams) lines.push(`Params: ${JSON.stringify(step.actionParams).slice(0, 500)}`);
			if (step.actionResult) lines.push(`Result: ${JSON.stringify(step.actionResult).slice(0, 500)}`);
			if (step.actionError) lines.push(`Error: ${step.actionError}`);
		}
		lines.push("");
	}

	const text = lines.join("\n");
	await emit(callback, text, "OVERWATCH_TRAJECTORY_DETAIL");
	return ok(text);
};

/** OVERWATCH_RUNTIME: inspect the current runtime — registered actions, providers, plugins. */
const runtimeInspectHandler: Handler = async (runtime, _m, _s, _options, callback) => {
	const r = runtime as unknown as {
		actions?: Array<{ name: string; description?: string }>;
		providers?: Array<{ name: string; description?: string }>;
		plugins?: Array<{ name: string; description?: string }>;
		agentId?: string;
		character?: { name?: string };
	};

	const lines: string[] = [];
	lines.push("# Runtime Inspection");
	lines.push(`Agent: ${r.character?.name ?? "unknown"} (${r.agentId ?? "?"})`);
	lines.push("");

	if (r.actions) {
		lines.push(`## Registered Actions (${r.actions.length})`);
		for (const a of r.actions) {
			lines.push(`• ${a.name}${a.description ? ` — ${a.description.slice(0, 100)}` : ""}`);
		}
		lines.push("");
	}

	if (r.providers) {
		lines.push(`## Registered Providers (${r.providers.length})`);
		for (const p of r.providers) {
			lines.push(`• ${p.name}${p.description ? ` — ${p.description.slice(0, 100)}` : ""}`);
		}
		lines.push("");
	}

	if (r.plugins) {
		lines.push(`## Loaded Plugins (${r.plugins.length})`);
		for (const p of r.plugins) {
			lines.push(`• ${p.name}${p.description ? ` — ${p.description.slice(0, 80)}` : ""}`);
		}
	}

	const text = lines.join("\n");
	await emit(callback, text, "OVERWATCH_RUNTIME");
	return ok(text);
};

/** OVERWATCH_TEST_PROMPT: fire a test prompt through the inbox and track the trajectory. */
const testPromptHandler: Handler = async (runtime, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const prompt = pick(opts, ["prompt", "text", "message"]);
	if (!prompt) return fail("Missing test prompt (params: prompt). Example: 'What CLIs do I have installed?'");

	// We can't directly import InboxService, but the runtime may have it
	// We'll use the runtime's messageService directly
	const r = runtime as unknown as {
		agentId?: string;
		messageService?: {
			handleMessage: (
				runtime: IAgentRuntime,
				message: Memory,
				callback?: (content: { text?: string } | null) => Promise<unknown[]>,
			) => Promise<unknown>;
		};
	};

	if (!r.messageService?.handleMessage) {
		return fail("messageService not available — can't fire test prompt.");
	}

	const { stringToUuid } = await import("@elizaos/core");
	const testId = `overwatch-test-${Date.now()}`;

	const memory: Memory = {
		id: stringToUuid(testId),
		entityId: stringToUuid("overwatch:tester"),
		agentId: r.agentId as Memory["agentId"],
		roomId: stringToUuid("overwatch:test-room"),
		content: {
			text: `[OVERWATCH TEST] ${prompt}`,
			source: "overwatch:test",
			attachments: [],
		},
		createdAt: Date.now(),
		metadata: { modelTier: "auto", overwatchTest: true, testId } as unknown as Memory["metadata"],
	};

	const replies: string[] = [];
	const startTime = Date.now();

	try {
		await r.messageService.handleMessage(runtime, memory, async (content) => {
			const text = typeof content?.text === "string" ? content.text : "";
			if (text) replies.push(text);
			return [];
		});
	} catch (err) {
		const elapsedMs = Date.now() - startTime;
		const errMsg = `Test prompt failed after ${elapsedMs}ms: ${err instanceof Error ? err.message : String(err)}`;
		await emit(callback, errMsg, "OVERWATCH_TEST_PROMPT");
		return fail(errMsg);
	}

	const elapsedMs = Date.now() - startTime;
	const result = [
		`# Test Prompt Result`,
		`Prompt: ${prompt}`,
		`Duration: ${(elapsedMs / 1000).toFixed(1)}s`,
		`Replies: ${replies.length}`,
		"",
		...replies.map((r, i) => `## Reply ${i + 1}\n${r}\n`),
	].join("\n");

	await emit(callback, result, "OVERWATCH_TEST_PROMPT");
	return ok(result);
};

/** OVERWATCH_ACTION_STATS: compute per-action success/failure stats from recent trajectories. */
const actionStatsHandler: Handler = async (runtime, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const limit = pickNum(opts, ["limit", "trajectoryCount"]) ?? 50;

	const svc = findTrajectoryService(runtime);
	if (!svc?.listTrajectories || !svc.getTrajectoryDetail) {
		return fail("Trajectory service not available.");
	}

	const list = await svc.listTrajectories({ limit });
	const stats = new Map<string, { total: number; success: number; fail: number; errors: string[] }>();

	for (const t of list.trajectories) {
		const raw = await svc.getTrajectoryDetail(t.id);
		if (!raw) continue;
		const detail = flattenTrajectory(raw);
		for (const step of detail.steps) {
			if (!step.actionName) continue;
			const entry = stats.get(step.actionName) ?? { total: 0, success: 0, fail: 0, errors: [] };
			entry.total++;
			if (step.actionSuccess) {
				entry.success++;
			} else if (step.actionSuccess === false) {
				entry.fail++;
				if (step.actionError) entry.errors.push(step.actionError.slice(0, 100));
			}
			stats.set(step.actionName, entry);
		}
	}

	const lines = [`# Action Stats (last ${list.trajectories.length} trajectories)\n`];
	const sorted = [...stats.entries()].sort((a, b) => b[1].total - a[1].total);
	for (const [name, s] of sorted) {
		const rate = s.total > 0 ? Math.round((s.success / s.total) * 100) : 0;
		const errorSample = s.errors.length > 0 ? ` | Errors: ${s.errors.slice(0, 2).join("; ")}` : "";
		lines.push(`• ${name}: ${s.total} calls, ${rate}% success (✅${s.success} ❌${s.fail})${errorSample}`);
	}

	const text = lines.join("\n");
	await emit(callback, text, "OVERWATCH_ACTION_STATS");
	return ok(text);
};

// ── Action definitions ──────────────────────────────────────────────────

const alwaysValid: Action["validate"] = async () => true;

const overwatchTrajectories: Action = {
	name: "OVERWATCH_TRAJECTORIES",
	similes: ["LIST_TRAJECTORIES", "TRAJECTORY_LIST", "MY_TRAJECTORIES"],
	description:
		"List recent agent trajectories with summary stats (duration, LLM calls, tokens). " +
		"Params: limit? (number, default 20), status? ('active'|'completed'|'error'), source?, q? (search).",
	validate: alwaysValid,
	handler: listTrajectoriesHandler,
};

const overwatchTrajectoryDetail: Action = {
	name: "OVERWATCH_TRAJECTORY_DETAIL",
	similes: ["GET_TRAJECTORY", "TRAJECTORY_DETAIL", "INSPECT_TRAJECTORY"],
	description:
		"Get full details of a trajectory — every step, LLM call (model, tokens, latency, prompt, response), " +
		"action (name, params, success, result, error), and reasoning. " +
		"Params: id (trajectory ID from OVERWATCH_TRAJECTORIES).",
	validate: alwaysValid,
	handler: trajectoryDetailHandler,
};

const overwatchRuntime: Action = {
	name: "OVERWATCH_RUNTIME",
	similes: ["INSPECT_RUNTIME", "LIST_ACTIONS", "RUNTIME_STATUS"],
	description:
		"Inspect the current runtime — lists all registered actions, providers, and plugins. " +
		"Use this to verify which tools the agent has access to.",
	validate: alwaysValid,
	handler: runtimeInspectHandler,
};

const overwatchTestPrompt: Action = {
	name: "OVERWATCH_TEST_PROMPT",
	similes: ["TEST_PROMPT", "SELF_TEST", "DRY_RUN_PROMPT"],
	description:
		"Fire a test prompt through the agent's message pipeline and observe the result. " +
		"Use this to verify the agent handles specific inputs correctly. " +
		"Params: prompt (the text to test with).",
	validate: alwaysValid,
	handler: testPromptHandler,
};

const overwatchActionStats: Action = {
	name: "OVERWATCH_ACTION_STATS",
	similes: ["ACTION_STATS", "TOOL_STATS", "ACTION_SUCCESS_RATE"],
	description:
		"Compute per-action success/failure statistics from recent trajectories. " +
		"Shows which actions succeed, which fail, and common errors. " +
		"Params: limit? (number of trajectories to analyze, default 50).",
	validate: alwaysValid,
	handler: actionStatsHandler,
};

// ── Context provider ────────────────────────────────────────────────────

const overwatchContextProvider: Provider = {
	name: "OVERWATCH_CONTEXT",
	description: "Overwatch observability — lets the agent inspect its own trajectories, tool calls, and performance.",
	descriptionCompressed: "Self-inspection and evaluation APIs.",
	position: 60,
	get: async (_runtime: IAgentRuntime, _m: Memory, _s: State): Promise<ProviderResult> => {
		return {
			text: [
				"## Overwatch — Self-Inspection APIs",
				"",
				"You have observability actions that let you inspect your own performance:",
				"• OVERWATCH_TRAJECTORIES — list recent turns with summary stats (LLM calls, tokens, duration)",
				"• OVERWATCH_TRAJECTORY_DETAIL — deep-dive into any trajectory: every step, action call, params, result, error",
				"• OVERWATCH_RUNTIME — list all registered actions, providers, plugins on the current runtime",
				"• OVERWATCH_TEST_PROMPT — fire a test message and observe the response",
				"• OVERWATCH_ACTION_STATS — per-action success rate across recent trajectories",
				"",
				"Use these during self-benchmark and SOTA eval passes to grade performance with real data.",
			].join("\n"),
		};
	},
};

// ── Plugin ──────────────────────────────────────────────────────────────

export function createOverwatchPlugin(): Plugin {
	return {
		name: "@detour/plugin-overwatch",
		description:
			"Agent self-inspection and evaluation — trajectory analysis, action stats, " +
			"runtime introspection, and test prompt execution for autonomous self-improvement.",
		actions: [
			overwatchTrajectories,
			overwatchTrajectoryDetail,
			overwatchRuntime,
			overwatchTestPrompt,
			overwatchActionStats,
		],
		providers: [overwatchContextProvider],
	};
}
