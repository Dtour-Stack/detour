/**
 * Pure trajectory extractors.
 *
 * Two simplified views over the full ActivityTrajectoryDetail:
 *
 *   - SimpleView: what a non-technical user wants to see — the original
 *     ask, what the agent actually replied, and the agent's chain of
 *     thinking. No system prompts, no tool plumbing, no model metadata.
 *
 *   - PromptsView: every system+user prompt that actually went into a
 *     model call, in order. For prompt-engineering work.
 *
 * Both are pure functions so they're trivial to unit-test.
 */

import type { ActivityTrajectoryDetail, ActivityLlmCall } from "../../shared/index";

export interface TrajectorySimpleView {
	request: string | null;
	reply: string | null;
	thinking: TrajectoryThinkingStep[];
	actionsTaken: TrajectoryActionTaken[];
	/** Aggregate cost + count signals so the UI can show "what did this turn use" at a glance. */
	totals: TrajectoryTotalsSummary;
	/** Models/providers that handled LLM calls on this turn, in order of first appearance. */
	providers: TrajectoryProviderSummary[];
	/** Companion (small sidecar) job outputs captured during the turn. */
	companion: TrajectoryCompanionSummary;
	/** Channel of origin (chat / discord / x / telegram / cron / x_autonomy / messageService …) */
	source: string | null;
	/** Hard failures — model errors, parse failures, etc — for quick scan. */
	failures: TrajectoryFailureSummary[];
}

export interface TrajectoryTotalsSummary {
	llmCallCount: number;
	totalPromptTokens: number;
	totalCompletionTokens: number;
	totalLatencyMs: number;
	successfulActionCount: number;
	failedActionCount: number;
}

export interface TrajectoryProviderSummary {
	model: string;
	purpose?: string;
	calls: number;
	promptTokens: number;
	completionTokens: number;
	latencyMs: number;
}

export interface TrajectoryCompanionSummary {
	triage?: string;
	personaFrame?: string;
	memoryQueries?: string[];
	compressedHistory?: string;
	shouldRespond?: boolean;
}

export interface TrajectoryFailureSummary {
	stepNumber: number;
	source: "llm" | "action" | "step";
	model?: string;
	message: string;
}

export interface TrajectoryThinkingStep {
	stepNumber: number;
	timestamp: number;
	stepType?: string;
	text: string;
}

export interface TrajectoryActionTaken {
	stepNumber: number;
	timestamp: number;
	name: string;
	success?: boolean;
	resultPreview?: string;
}

export interface TrajectoryPromptEntry {
	callId: string;
	stepNumber: number;
	timestamp: number;
	model: string;
	stepType?: string;
	purpose?: string;
	systemPrompt: string | null;
	userPrompt: string | null;
	response: string | null;
}

interface MaybeRecord {
	[key: string]: unknown;
}

function asRecord(value: unknown): MaybeRecord | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as MaybeRecord)
		: null;
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Pull the original user request. Prefers raw.rootMessage.text (the
 * on-disk shape stores the exact user prose). Falls back to the first
 * user-prompt seen in llmCalls when raw is unavailable.
 */
export function extractRequest(detail: ActivityTrajectoryDetail): string | null {
	const raw = asRecord(detail.raw);
	const root = asRecord(raw?.rootMessage);
	const fromRoot = asString(root?.text);
	if (fromRoot) return fromRoot;
	for (const call of detail.llmCalls) {
		const fromUser = asString(call.userPrompt);
		if (fromUser) {
			// On the first should_respond/compose_state pass, the user
			// prompt typically begins with the user's message verbatim
			// or includes it under a clear marker. Return what we have —
			// callers can truncate.
			return fromUser;
		}
	}
	return null;
}

/**
 * Pull the final agent reply. Strategy in order of preference:
 *  1. The result of the LAST successful REPLY action (clean, ideal)
 *  2. The `text:` field of the LAST ACTION_PLANNER TOON response —
 *     this is where eliza's planner emits the user-facing reply when
 *     no separate REPLY action is dispatched. Handles the code-text
 *     multi-line wrapper (`"code_text_start": "X"` ... `"code_text_end": "X"`).
 *  3. The response of the LAST LLM call overall as a final fallback.
 *
 * Without (2), trajectories from the standard eliza message pipeline
 * surface the planner's raw TOON (thought/relationships/etc.) as "reply",
 * which is the planner's INTERNAL state — not what the user actually saw.
 */
/**
 * Heuristic: TOON config snippets (`providers:`, `useKnowledgeProviders: false`,
 * `ops[1]: ...`) look like keyed lines, are short, and don't read as prose.
 * Prose replies have sentences and length. Reject anything that's just
 * "word:" or "word: word" or "word[idx]:" with no follow-on prose.
 */
function looksLikeToonSnippet(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length < 40 && /^[\w[\]\d]+\s*:\s*\S*\s*$/.test(trimmed)) return true;
	return false;
}

export function extractReply(detail: ActivityTrajectoryDetail): string | null {
	const replyAction = [...detail.actions]
		.reverse()
		.find((a) => a.actionName === "REPLY" || a.actionType === "REPLY");
	if (replyAction) {
		const replyResult = asRecord(replyAction.result);
		const text = asString(replyResult?.text);
		if (text) return text;
	}
	// `purpose: "response"` marks the LLM calls that emit user-facing text
	// (interim or final). When eliza takes the action-then-summarize path,
	// the LAST such call is the post-action summary that the user actually
	// sees. When eliza takes the planner-only path (no action), there's only
	// one response call — the ACTION_PLANNER's TOON output — and the user
	// reply is in its `text:` field.
	const responseCalls = detail.llmCalls
		.filter((c) => c.purpose === "response" && typeof c.response === "string")
		.sort((a, b) => a.timestamp - b.timestamp);
	const last = responseCalls.at(-1);
	if (last && typeof last.response === "string") {
		if (last.model === "ACTION_PLANNER") {
			const fromToon = parseTextFromToon(last.response);
			if (fromToon) return fromToon;
		} else {
			// Skip clearly non-prose responses (TOON config snippets / nothing).
			const trimmed = last.response.trim();
			if (trimmed.length > 0 && !looksLikeToonSnippet(trimmed)) {
				return trimmed;
			}
		}
	}
	// Final fallback: walk all response-purpose calls newest-first and pick
	// the first one whose body parses to a non-empty prose reply.
	for (const c of [...responseCalls].reverse()) {
		const body = typeof c.response === "string" ? c.response : "";
		const fromToon = c.model === "ACTION_PLANNER" ? parseTextFromToon(body) : body.trim();
		if (fromToon && fromToon.length > 0 && !looksLikeToonSnippet(fromToon)) return fromToon;
	}
	const fallback = detail.llmCalls.at(-1);
	if (fallback?.response) return fallback.response;
	return null;
}

/**
 * Parse the `text:` field out of an eliza TOON document. Handles three shapes:
 *
 *   text: "single-line literal"
 *   text: bare unquoted single line
 *   text: "code_text_start": "<tag>"
 *         multi-line
 *         content
 *   "code_text_end": "<tag>"
 *
 * Returns null when no `text:` field is found at all.
 */
export function parseTextFromToon(toon: string): string | null {
	const lines = toon.split(/\r?\n/);
	const idx = lines.findIndex((l) => /^\s*text\s*:/.test(l));
	if (idx === -1) return null;
	const header = lines[idx]!.replace(/^\s*text\s*:\s*/, "");
	// Two real-world TOON formats observed: quoted (`"code_text_start": "tag"`)
	// and bare (`code_text_start: tag`). Handle both — the end marker uses
	// the matching shape.
	const codeStart = header.match(/^"?code_text_start"?\s*:\s*"?([A-Za-z0-9_-]+)"?\s*$/);
	if (codeStart) {
		const tag = codeStart[1];
		const collected: string[] = [];
		for (let i = idx + 1; i < lines.length; i++) {
			const trimmed = lines[i]!.trim();
			if (
				trimmed === `"code_text_end": "${tag}"` ||
				trimmed === `code_text_end: ${tag}`
			) {
				return collected.join("\n").trim() || null;
			}
			collected.push(lines[i]!);
		}
		// missing end marker — return what we have
		return collected.join("\n").trim() || null;
	}
	// Single-line text: strip surrounding quotes if present
	const single = header.replace(/^"(.*)"$/s, "$1").trim();
	return single.length > 0 ? single : null;
}

/**
 * Walk the trajectory and surface every "thinking" / "reasoning"
 * artifact the agent produced. Sources, in order:
 *  - step.reasoning (per-step structured reasoning)
 *  - llmCall.reasoning (model-emitted reasoning, e.g. extended thinking)
 *
 * Dedupes on (stepNumber, text) so we don't double up when a step's
 * reasoning equals its first LLM call's reasoning.
 */
export function extractThinking(
	detail: ActivityTrajectoryDetail,
): TrajectoryThinkingStep[] {
	const out: TrajectoryThinkingStep[] = [];
	const seen = new Set<string>();
	const add = (entry: TrajectoryThinkingStep): void => {
		const key = `${entry.stepNumber}::${entry.text.slice(0, 80)}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push(entry);
	};
	for (const step of detail.steps) {
		const text = asString(step.reasoning);
		if (text) {
			add({
				stepNumber: step.stepNumber,
				timestamp: step.timestamp,
				...(step.metadata && typeof step.metadata.stepType === "string"
					? { stepType: step.metadata.stepType as string }
					: {}),
				text,
			});
		}
	}
	for (const call of detail.llmCalls) {
		const text = asString(call.reasoning);
		if (text) {
			add({
				stepNumber: call.stepNumber,
				timestamp: call.timestamp,
				...(call.stepType ? { stepType: call.stepType } : {}),
				text,
			});
		}
	}
	out.sort((a, b) => a.stepNumber - b.stepNumber || a.timestamp - b.timestamp);
	return out;
}

/**
 * Summarize each action attempt the agent made — name + success + a
 * short preview of the result. For the simple view we don't dump full
 * action payloads; the full trajectory view already does that.
 */
export function extractActionsTaken(
	detail: ActivityTrajectoryDetail,
): TrajectoryActionTaken[] {
	return detail.actions
		.map((a) => {
			const name = a.actionName ?? a.actionType ?? "(unknown)";
			const resultRec = asRecord(a.result);
			const preview =
				asString(resultRec?.text) ??
				asString(resultRec?.summary) ??
				asString(resultRec?.message);
			return {
				stepNumber: a.stepNumber,
				timestamp: a.timestamp,
				name,
				...(typeof a.success === "boolean" && { success: a.success }),
				...(preview && { resultPreview: preview.slice(0, 240) }),
			};
		})
		// Drop pending placeholders. Every trajectory step is initialised
		// with a `{ actionName: "pending", actionType: "pending", success:
		// false }` action stub by TrajectoriesService.createStep, and only
		// the steps that actually represent action invocations get that
		// stub overwritten via completeActionTrajectoryStep. LLM-call and
		// provider-render steps legitimately leave the stub in place — so
		// surfacing it as an "action taken" in the simple view turns every
		// turn into a wall of "150 pending action attempts" that doesn't
		// reflect what the agent actually did.
		.filter((a) => a.name !== "pending" && a.name !== "(unknown)");
}

export function extractSimpleView(detail: ActivityTrajectoryDetail): TrajectorySimpleView {
	return {
		request: extractRequest(detail),
		reply: extractReply(detail),
		thinking: extractThinking(detail),
		actionsTaken: extractActionsTaken(detail),
		totals: extractTotals(detail),
		providers: extractProviders(detail),
		companion: extractCompanion(detail),
		source: extractSource(detail),
		failures: extractFailures(detail),
	};
}

/**
 * Sum LLM calls + token counts + latency + action success/failure counts
 * so the UI can render "this turn used N calls, M tokens, T seconds, K
 * actions (J failed)" in one line.
 */
export function extractTotals(detail: ActivityTrajectoryDetail): TrajectoryTotalsSummary {
	let totalPromptTokens = 0;
	let totalCompletionTokens = 0;
	let totalLatencyMs = 0;
	let llmCallCount = 0;
	for (const c of detail.llmCalls) {
		llmCallCount += 1;
		const prompt = (c as { promptTokens?: number }).promptTokens ?? 0;
		const completion = (c as { completionTokens?: number }).completionTokens ?? 0;
		const latency = (c as { latencyMs?: number }).latencyMs ?? 0;
		totalPromptTokens += prompt;
		totalCompletionTokens += completion;
		totalLatencyMs += latency;
	}
	let successfulActionCount = 0;
	let failedActionCount = 0;
	for (const a of detail.actions) {
		const name = a.actionName ?? a.actionType ?? "";
		if (!name || name === "pending") continue;
		if (a.success === true) successfulActionCount += 1;
		else if (a.success === false) failedActionCount += 1;
	}
	return {
		llmCallCount,
		totalPromptTokens,
		totalCompletionTokens,
		totalLatencyMs,
		successfulActionCount,
		failedActionCount,
	};
}

/**
 * Walk llmCalls grouped by model (plus purpose when distinct) so the
 * Simple view can show "Codex did 4 calls, Anthropic did 1 retry,
 * companion did 3 jobs." Order: first-seen.
 */
export function extractProviders(
	detail: ActivityTrajectoryDetail,
): TrajectoryProviderSummary[] {
	const order: string[] = [];
	const byKey = new Map<string, TrajectoryProviderSummary>();
	for (const c of detail.llmCalls) {
		const model = c.model ?? "unknown";
		const purpose = c.purpose ?? undefined;
		const key = purpose ? `${model}#${purpose}` : model;
		if (!byKey.has(key)) {
			order.push(key);
			byKey.set(key, {
				model,
				...(purpose ? { purpose } : {}),
				calls: 0,
				promptTokens: 0,
				completionTokens: 0,
				latencyMs: 0,
			});
		}
		const summary = byKey.get(key)!;
		summary.calls += 1;
		summary.promptTokens += (c as { promptTokens?: number }).promptTokens ?? 0;
		summary.completionTokens +=
			(c as { completionTokens?: number }).completionTokens ?? 0;
		summary.latencyMs += (c as { latencyMs?: number }).latencyMs ?? 0;
	}
	return order.map((k) => byKey.get(k)!);
}

/**
 * Pull companion job outputs from trajectory metadata when the agent
 * recorded them. CompanionService writes a `companion` block per turn
 * onto the trajectory metadata (see AgentHfSyncService for the dump
 * schema). When absent, returns an empty object — the UI gracefully
 * hides the section.
 */
export function extractCompanion(
	detail: ActivityTrajectoryDetail,
): TrajectoryCompanionSummary {
	const meta = (detail.trajectory as { metadata?: Record<string, unknown> } | null)
		?.metadata;
	if (!meta || typeof meta !== "object") return {};
	const companion =
		(meta as { companion?: Record<string, unknown> }).companion ?? {};
	if (!companion || typeof companion !== "object") return {};
	const result: TrajectoryCompanionSummary = {};
	if (typeof companion.triage === "string") result.triage = companion.triage;
	if (typeof companion.personaFrame === "string")
		result.personaFrame = companion.personaFrame;
	if (Array.isArray(companion.memoryQueries)) {
		result.memoryQueries = (companion.memoryQueries as unknown[])
			.filter((q): q is string => typeof q === "string")
			.slice(0, 5);
	}
	if (typeof companion.compressedHistory === "string")
		result.compressedHistory = companion.compressedHistory;
	if (typeof companion.shouldRespond === "boolean")
		result.shouldRespond = companion.shouldRespond;
	return result;
}

export function extractSource(detail: ActivityTrajectoryDetail): string | null {
	const traj = detail.trajectory as { source?: string } | null;
	if (traj?.source && typeof traj.source === "string") return traj.source;
	const meta = (detail.trajectory as { metadata?: Record<string, unknown> } | null)
		?.metadata;
	if (meta && typeof meta === "object") {
		const s = (meta as { source?: unknown }).source;
		if (typeof s === "string" && s.length > 0) return s;
	}
	return null;
}

export function extractFailures(
	detail: ActivityTrajectoryDetail,
): TrajectoryFailureSummary[] {
	const out: TrajectoryFailureSummary[] = [];
	for (const c of detail.llmCalls) {
		const error = (c as { error?: unknown }).error;
		if (typeof error === "string" && error.length > 0) {
			out.push({
				stepNumber: c.stepNumber ?? 0,
				source: "llm",
				...(c.model ? { model: c.model } : {}),
				message: error,
			});
		}
	}
	for (const a of detail.actions) {
		if (a.success === false) {
			const name = a.actionName ?? a.actionType ?? "action";
			if (name === "pending") continue;
			const result = a.result as { error?: string; text?: string } | undefined;
			const msg =
				(typeof result?.error === "string" && result.error) ||
				(typeof result?.text === "string" && result.text) ||
				`${name} failed`;
			out.push({
				stepNumber: a.stepNumber ?? 0,
				source: "action",
				message: msg.slice(0, 240),
			});
		}
	}
	return out;
}

/**
 * Extract every prompt-bearing LLM call, in step order. Used by the
 * Prompts tab so the user can see exactly what was sent to the model.
 */
export function extractPrompts(detail: ActivityTrajectoryDetail): TrajectoryPromptEntry[] {
	return detail.llmCalls
		.filter((c) => c.systemPrompt || c.userPrompt)
		.map((c: ActivityLlmCall) => ({
			callId: c.callId,
			stepNumber: c.stepNumber,
			timestamp: c.timestamp,
			model: c.model,
			...(c.stepType && { stepType: c.stepType }),
			...(c.purpose && { purpose: c.purpose }),
			systemPrompt: c.systemPrompt ?? null,
			userPrompt: c.userPrompt ?? null,
			response: c.response ?? null,
		}))
		.sort((a, b) => a.stepNumber - b.stepNumber || a.timestamp - b.timestamp);
}
