/**
 * Free-form planner — drop-in replacement for the path eliza's
 * `dynamicPromptExecFromState` takes when given a "reply-like" schema
 * `{thought, actions, providers, text, simple}`.
 *
 * Why exists:
 *   The strict 5-field structured planner fails repeatedly when the
 *   active model doesn't produce a perfectly-formed JSON document
 *   that satisfies every field's validators. Each retry is a model
 *   round-trip + parse attempt. We've seen 3-11 retries per turn fail
 *   uniformly, leaving trajectories full of "pending" actions and the
 *   user with the plain-text fallback (which works, but bypasses real
 *   action selection so the agent can't actually DO things from chat).
 *
 * What this does:
 *   1. Read the live `runtime.actions` registry → list of action names
 *   2. Build a plain-text prompt asking the model to:
 *        ACTIONS: <comma list, may be empty / REPLY only>
 *        REPLY: <message text>
 *        THOUGHT: <brief reasoning>
 *   3. Call `runtime.useModel(TEXT_LARGE, {prompt})` — no schema
 *   4. Parse with tolerant regex — accepts markdown wrappers, missing
 *      lines, reordered fields, indentation
 *   5. Return the same result shape DPE would have: matches eliza's
 *      downstream pipeline (callback emits, action dispatch, etc).
 *
 * Why this beats the structured planner:
 *   - No JSON validation = the model never has to "get it perfect"
 *   - Works with any model: plain text is universal
 *   - Free-form parse handles markdown fences, missing fields, etc
 *   - One model call instead of 3-11 retries
 *
 * Wiring: installFreeformPlannerPatch() patches `runtime.
 * dynamicPromptExecFromState` so reply-like schemas take this path
 * by default. Non-reply schemas pass through to the original
 * implementation untouched.
 */

import {
	ModelType,
	type IAgentRuntime,
	type Plugin,
	type State,
} from "@elizaos/core";

const WRAPPED = Symbol.for("detour.freeformPlanner.wrapped");
const PLANNER_FIELDS = new Set(["thought", "actions", "providers", "text", "simple"]);

type DynamicPromptArgs = Parameters<IAgentRuntime["dynamicPromptExecFromState"]>[0];
type DynamicPromptResult = Awaited<ReturnType<IAgentRuntime["dynamicPromptExecFromState"]>>;
type WrappedRuntime = IAgentRuntime & { [WRAPPED]?: true };

// Runtime has ~191 actions; the cap was hiding two-thirds of the surface
// from the planner, including CALENDAR_LIST_TODAY / MUSIC_NOW_PLAYING /
// LOGIN_LIST / GMGN_* / X_* etc. Lift to cover everything. Each action
// line is short (name + short description + param list) so the prompt
// stays under model context comfortably.
const MAX_ACTIONS_IN_PROMPT = 250;
const MAX_RECENT_CHARS = 3500;

function isReplyLikeSchema(args: DynamicPromptArgs): boolean {
	const fields = new Set(args.schema.map((row) => row.field));
	for (const field of PLANNER_FIELDS) {
		if (!fields.has(field)) return false;
	}
	return true;
}

function recentMessagesText(state: State | undefined): string {
	const recent = state?.values?.recentMessages;
	if (typeof recent === "string" && recent.length > 0) {
		return recent.slice(-MAX_RECENT_CHARS);
	}
	const text = state?.text;
	if (typeof text === "string" && text.length > 0) return text.slice(-MAX_RECENT_CHARS);
	return "";
}

function extractUserText(args: DynamicPromptArgs): string {
	const recent = args.state?.values?.recentMessages;
	if (typeof recent !== "string" || recent.length === 0) return "";
	const lines = recent.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const m = lines[i]?.match(/User:\s*(.+)$/);
		if (m?.[1]) return m[1].trim();
	}
	return "";
}

function characterContext(runtime: IAgentRuntime): string {
	const char = runtime.character as {
		name?: unknown;
		system?: unknown;
		bio?: unknown;
		style?: { all?: unknown; chat?: unknown };
	};
	const lines: string[] = [];
	if (typeof char.name === "string") lines.push(`You are ${char.name}.`);
	if (typeof char.system === "string" && char.system.length > 0) {
		lines.push(char.system.trim());
	}
	if (Array.isArray(char.bio)) {
		const bio = char.bio.filter((b): b is string => typeof b === "string").slice(0, 3);
		if (bio.length > 0) lines.push(bio.join(" "));
	}
	const style = char.style;
	if (style && typeof style === "object") {
		const all = Array.isArray(style.all) ? style.all.filter((s): s is string => typeof s === "string").slice(0, 3) : [];
		const chat = Array.isArray(style.chat) ? style.chat.filter((s): s is string => typeof s === "string").slice(0, 3) : [];
		if (all.length > 0) lines.push(`Style: ${all.join(" • ")}`);
		if (chat.length > 0) lines.push(`In chat: ${chat.join(" • ")}`);
	}
	return lines.join("\n").slice(0, 1500);
}

interface ActionParamInfo {
	name: string;
	required: boolean;
	description: string | null;
	type: string | null;
}
interface ActionInfo {
	name: string;
	description: string | null;
	parameters: ActionParamInfo[];
}

function listAvailableActions(runtime: IAgentRuntime): ActionInfo[] {
	const actions = (runtime as unknown as {
		actions?: Array<{
			name: string;
			description?: string;
			parameters?: Array<{
				name: string;
				required?: boolean;
				description?: string;
				schema?: { type?: string };
			}>;
		}>;
	}).actions ?? [];
	const filtered = actions.filter((a) => {
		const n = a.name?.toUpperCase();
		return n && n !== "IGNORE" && n !== "NONE";
	});
	return filtered.slice(0, MAX_ACTIONS_IN_PROMPT).map((a) => ({
		name: a.name,
		description: a.description?.slice(0, 120) ?? null,
		parameters: (a.parameters ?? []).map((p) => ({
			name: p.name,
			required: !!p.required,
			description: p.description?.slice(0, 80) ?? null,
			type: p.schema?.type ?? null,
		})),
	}));
}

function buildPrompt(
	runtime: IAgentRuntime,
	args: DynamicPromptArgs,
	availableActions: ActionInfo[],
): string {
	const userText = extractUserText(args);
	const recent = recentMessagesText(args.state);
	const character = characterContext(runtime);
	const actionsBlock = availableActions
		.map((a) => {
			const head = a.description ? `  - ${a.name}: ${a.description}` : `  - ${a.name}`;
			if (a.parameters.length === 0) return head;
			const paramList = a.parameters
				.map((p) => {
					const req = p.required ? "" : "?";
					const ty = p.type ? `:${p.type}` : "";
					return `${p.name}${req}${ty}`;
				})
				.join(", ");
			return `${head}\n      params: ${paramList}`;
		})
		.join("\n");

	return [
		character,
		``,
		`# Planner`,
		`Given the user's latest message, decide which action(s) to fire and what to reply.`,
		`Output EXACTLY this format, no extra commentary, no markdown, no JSON wrapper:`,
		``,
		`ACTIONS: <comma-separated action names, or REPLY if no special action is needed>`,
		`PARAMS: <JSON object keyed by action name with that action's params, e.g. {"PENSIEVE_SEARCH":{"query":"detour","limit":10}}. Use {} if no actions need params.>`,
		`REPLY: <your reply text — what the user will see>`,
		`THOUGHT: <one sentence explaining why you picked those actions>`,
		``,
		`# Available actions (params marked with ? are optional; required ones MUST be in PARAMS)`,
		actionsBlock,
		``,
		`# Recent conversation`,
		recent || "(no prior messages)",
		``,
		`# User just said`,
		userText || "(no text)",
		``,
		`# Your output (ACTIONS / PARAMS / REPLY / THOUGHT, exactly that format)`,
	].join("\n");
}

interface ParsedPlan {
	actions: string[];
	reply: string;
	thought: string;
	params: Record<string, Record<string, unknown>>;
}

export function parseFreeformResponse(raw: string, validActionNames: Set<string>): ParsedPlan | null {
	if (!raw || raw.trim().length === 0) return null;
	let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
	text = text.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/i, "");
	const actionsMatch = text.match(/^\s*ACTIONS:\s*(.+?)(?:\r?\n|$)/im);
	const paramsMatch = text.match(/^\s*PARAMS:\s*([\s\S]+?)(?=^\s*(?:ACTIONS|REPLY|THOUGHT):|\s*$)/im);
	const replyMatch = text.match(/^\s*REPLY:\s*([\s\S]+?)(?=^\s*(?:ACTIONS|PARAMS|THOUGHT):|\s*$)/im);
	const thoughtMatch = text.match(/^\s*THOUGHT:\s*(.+?)(?:\r?\n|$)/im);

	const actions = parsePlannerActions(actionsMatch?.[1], validActionNames);
	const reply = parsePlannerReply(text, replyMatch?.[1]);
	const thought = thoughtMatch?.[1]?.trim() ?? "Free-form planner";
	const params = parsePlannerParams(paramsMatch?.[1]);

	if (!reply && actions.length === 0) return null;
	return { actions, reply, thought, params };
}

function parsePlannerActions(raw: string | undefined, validActionNames: Set<string>): string[] {
	const actions = raw
		? raw
				.split(/[,;]/)
				.map((s) => s.trim().toUpperCase().replace(/^["'`]+|["'`]+$/g, ""))
				.filter((s) => s.length > 0 && validActionNames.has(s))
		: [];
	return actions.length > 0 ? actions : ["REPLY"];
}

function parsePlannerReply(text: string, raw: string | undefined): string {
	const reply = raw?.trim() || text
		.split("\n")
		.filter((line) => !/^\s*(ACTIONS|PARAMS|THOUGHT):/i.test(line))
		.join("\n")
		.trim();
	return reply.replace(/^["'`]+|["'`]+$/g, "").trim();
}

function parsePlannerParams(raw: string | undefined): Record<string, Record<string, unknown>> {
	const params: Record<string, Record<string, unknown>> = {};
	const paramsRaw = raw?.trim() ?? "";
	if (!paramsRaw || paramsRaw === "{}") return params;
	const cleaned = paramsRaw
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/i, "")
		.replace(/,\s*([}\]])/g, "$1");
	try {
		const parsed = JSON.parse(cleaned);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			for (const [k, v] of Object.entries(parsed)) {
				if (v && typeof v === "object" && !Array.isArray(v)) {
					params[k.toUpperCase()] = v as Record<string, unknown>;
				}
			}
		}
	} catch {}
	return params;
}

/// Pull `actionResults` from the planner state. Set by eliza's
/// `processActions` after each action runs, then passed back into the
/// planner via the post-action continuation pass (so we can decide
/// whether to fire ANOTHER action or wrap up with a REPLY).
function previousActionResults(args: DynamicPromptArgs): Array<{
	name?: string;
	text?: string;
	success?: boolean;
}> {
	const stateData = (args.state as { data?: Record<string, unknown> } | undefined)?.data;
	const raw = stateData?.actionResults;
	if (!Array.isArray(raw)) return [];
	return raw as Array<{ name?: string; text?: string; success?: boolean }>;
}

async function runFreeformPlanner(
	runtime: IAgentRuntime,
	args: DynamicPromptArgs,
): Promise<DynamicPromptResult> {
	const availableActions = listAvailableActions(runtime);
	if (availableActions.length === 0) return null;
	const validNames = new Set(availableActions.map((a) => a.name.toUpperCase()));
	// REPLY is always a valid choice (it's eliza's default "just talk").
	validNames.add("REPLY");

	// Post-action continuation guard: if any non-REPLY actions ALREADY
	// ran this turn, force a REPLY-only response. Without this, the
	// planner reads the same user prompt ("Use PENSIEVE_SEARCH for X")
	// and re-fires the same action — looping until eliza hits its
	// 300-second turn timeout. Symptom in trajectories: one tray-app
	// chat with 328 steps, llm=18, dur=325s, and 7× PENSIEVE_SEARCH in
	// `actions[]`. The user is told 5 of them via concatenated
	// "Search returned N hits" lines; the rest die at the ceiling.
	const priorResults = previousActionResults(args);
	const priorNonReply = priorResults.filter((r) => {
		const n = String(r.name ?? "").trim().toUpperCase();
		return n.length > 0 && n !== "REPLY";
	});
	if (priorNonReply.length > 0) {
		const last = priorNonReply[priorNonReply.length - 1];
		const lastText = typeof last?.text === "string" ? last.text.trim() : "";
		runtime.logger.info(
			{
				src: "detour:freeform-planner",
				priorActionCount: priorNonReply.length,
				lastAction: last?.name,
			},
			"Post-action continuation — forcing REPLY-only to break loop",
		);
		// Surface the most recent action result back to the user as the
		// reply. If empty, fall through to a brief acknowledgement so the
		// user isn't left hanging.
		return {
			thought: `Action(s) already ran this turn (${priorNonReply.length}); summarizing.`,
			actions: ["REPLY"],
			providers: "",
			text: lastText.length > 0 ? lastText : "Done.",
			simple: true,
		};
	}

	const prompt = buildPrompt(runtime, args, availableActions);

	// Use whatever tier the request asked for, but downgrade ACTION_PLANNER
	// → TEXT_LARGE since ACTION_PLANNER is the brittle structured-output
	// tier we're trying to escape. Honor DETOUR_PLANNER_TIER if set.
	const pinned = runtime.getSetting?.("DETOUR_PLANNER_TIER");
	let modelType: string = ModelType.TEXT_LARGE;
	if (typeof pinned === "string" && pinned.length > 0) {
		modelType = pinned;
	} else {
		const requested = args.options?.modelType as string | undefined;
		if (requested && requested !== ModelType.ACTION_PLANNER) {
			modelType = requested;
		}
	}

	const raw = await runtime.useModel(modelType as never, {
		prompt,
		maxTokens: 700,
		temperature: 0.5,
	});
	const text = typeof raw === "string" ? raw : "";
	const parsed = parseFreeformResponse(text, validNames);
	if (!parsed) {
		runtime.logger.warn(
			{ src: "detour:freeform-planner", raw: text.slice(0, 200) },
			"Free-form planner produced unparseable output",
		);
		return null;
	}
	runtime.logger.info(
		{
			src: "detour:freeform-planner",
			actions: parsed.actions,
			thought: parsed.thought.slice(0, 120),
			paramKeys: Object.keys(parsed.params),
		},
		"Free-form planner picked actions",
	);
	// Build the eliza-shape return. `params` is consumed by
	// `parseActionParams` in eliza-core (TOON-encoded action params
	// keyed by action name). It accepts a Record<string, unknown>
	// natively via `toActionParameterValue` walk, so passing the
	// JSON-decoded object works without a TOON encode step.
	const result: Record<string, unknown> = {
		thought: parsed.thought,
		actions: parsed.actions,
		providers: "",
		text: parsed.reply,
		simple: true,
	};
	if (Object.keys(parsed.params).length > 0) {
		result.params = parsed.params;
	}
	return result;
}

export function installFreeformPlannerPatch(runtime: IAgentRuntime): void {
	const wrapped = runtime as WrappedRuntime;
	if (wrapped[WRAPPED]) return;
	const original = runtime.dynamicPromptExecFromState.bind(runtime);
	wrapped.dynamicPromptExecFromState = async (
		args: DynamicPromptArgs,
	): Promise<DynamicPromptResult> => {
		// Only intercept reply-like schemas — leave specialized
		// structured calls (e.g. memory queries, summarization) on the
		// original path so we don't break unrelated code.
		if (!isReplyLikeSchema(args)) {
			return original(args);
		}
		try {
			const result = await runFreeformPlanner(runtime, args);
			// Short-circuit on any usable result. The freeform planner now
			// emits params alongside the action list (parsed from the
			// PARAMS: JSON line in the LLM response), so `processActions`
			// can dispatch directly without consulting the structured
			// ACTION_PLANNER. The eliza-side ACTION_PLANNER schema parser
			// rejects its own model's YAML output 0/8 — this short-circuit
			// is the action-dispatch fix.
			if (result && (result.text || (Array.isArray(result.actions) && result.actions.length > 0))) {
				return result;
			}
		} catch (err) {
			runtime.logger.warn(
				{ src: "detour:freeform-planner", err: err instanceof Error ? err.message : String(err) },
				"Free-form planner threw — falling back to original DPE",
			);
		}
		// Fallback: try the original eliza planner. The dpe-fallback
		// plugin further down the chain handles its own retries +
		// plain-text reply path.
		return original(args);
	};
	wrapped[WRAPPED] = true;
}

export const freeformPlannerPlugin: Plugin = {
	name: "detour-freeform-planner",
	description: "Replaces eliza's strict structured planner with a plain-text planner that picks actions reliably across any model.",
	init: (_config, runtime) => {
		installFreeformPlannerPatch(runtime);
	},
};
