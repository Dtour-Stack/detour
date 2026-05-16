/**
 * dpe-fallback-plugin — minimal safety net wrapping eliza's
 * `dynamicPromptExecFromState`.
 *
 * The free-form planner (`freeform-planner.ts`) is now the primary
 * planner for reply-like schemas. It runs FIRST in the wrapper chain
 * and almost always succeeds because it doesn't depend on strict
 * structured-output validation. This module is the LAST-RESORT net
 * that catches what falls through.
 *
 * It deliberately keeps only three things the freeform planner doesn't
 * cover:
 *
 *   1. **Companion pre-pass** — augments planner state with persona-
 *      framing (companion's personaPrePass) and compressed recent
 *      messages when the conversation history is too long. Strictly
 *      additive — never replaces user text.
 *
 *   2. **Quota-cap short-circuit** — when the active provider has a
 *      weekly usage cap (recorded by ProviderQuotaService), every
 *      model call will 429. Ship a clear "I'm capped, here's why"
 *      reply instead of letting downstream paths fail silently.
 *
 *   3. **Plain-text reply safety net** — if both the freeform planner
 *      AND the original eliza planner return null, fire one more
 *      attempt at the simplest possible model call (TEXT_SMALL plain
 *      text) so the user is never left with literal silence.
 *
 * Removed in the 2026-05 cleanup (the freeform planner makes these
 * obsolete):
 *   - The TIER_CASCADE (ACTION_PLANNER → TEXT_LARGE → TEXT_MEDIUM →
 *     TEXT_SMALL) — the freeform planner picks the tier it needs
 *     directly, no retries required.
 *   - `compactRetryArgs` + `normalizeReplyLikeSchema` — there's no
 *     structured retry to compact or normalize anymore.
 *   - PROVIDER_RECOVERY_TARGETS + `runProviderRecovery` — the freeform
 *     planner works across any provider that can output text. No
 *     special-case provider switching needed.
 *   - `setCompanionPlannerHook` wiring is preserved (still used by
 *     `core/index.ts` to register the companion service).
 */

import {
	getPlannerReplyContext,
	PLANNER_REPLY_CONTEXT_SNAPSHOT_STATE_KEY,
	type IAgentRuntime,
	ModelType,
	type Plugin,
	runWithPlannerReplyContext,
	type State,
} from "@elizaos/core";
import { getProviderQuotaService, type QuotaCap } from "./provider-quota-service";
import {
	DETOUR_DPE_FALLBACK_DEFAULT,
	DETOUR_DPE_FALLBACK_TEMPLATE,
	renderPromptTemplate,
} from "./prompt-templates";

const WRAPPED = Symbol.for("detour.dpeFallback.wrapped");
const PLANNER_FIELDS = new Set(["thought", "actions", "providers", "text", "simple"]);
const CHARACTER_CONTEXT_LIMIT = 2_500;
const ALWAYS_ON_CONTEXT_LIMIT = 4_000;
const STANDARD_CONVERSATION_LIMIT = 6_000;
const COMPACT_MEMORY_LIMIT = 1_500;
const COMPACT_CONVERSATION_LIMIT = 2_500;

type DynamicPromptArgs = Parameters<IAgentRuntime["dynamicPromptExecFromState"]>[0];
type DynamicPromptResult = Awaited<ReturnType<IAgentRuntime["dynamicPromptExecFromState"]>>;
type WrappedRuntime = IAgentRuntime & { [WRAPPED]?: true };

function isReplyLikeSchema(args: DynamicPromptArgs): boolean {
	const fields = new Set(args.schema.map((row) => row.field));
	for (const field of PLANNER_FIELDS) {
		if (!fields.has(field)) return false;
	}
	return true;
}

/** @deprecated kept for back-compat; prefer `runWithPlannerReplyContext`. */
export function runWithPlannerFallbackContext<T>(
	context: { source: string; addressed: boolean },
	run: () => T | Promise<T>,
): T | Promise<T> {
	return runWithPlannerReplyContext(context, run);
}

function readPlannerReplyContextSnapshot(
	state: State | undefined,
): { source: string; addressed: boolean } | undefined {
	const values = state?.values as Record<string, unknown> | undefined;
	const raw = values?.[PLANNER_REPLY_CONTEXT_SNAPSHOT_STATE_KEY];
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const o = raw as Record<string, unknown>;
	const source = typeof o.source === "string" ? o.source : "";
	const addressed = typeof o.addressed === "boolean" ? o.addressed : false;
	if (!source) return undefined;
	return { source, addressed };
}

function effectivePlannerReplyContext(
	args: DynamicPromptArgs,
): { source: string; addressed: boolean } | undefined {
	return getPlannerReplyContext() ?? readPlannerReplyContextSnapshot(args.state);
}

function canUsePlainReply(args: DynamicPromptArgs): boolean {
	if (!isReplyLikeSchema(args)) return false;
	const ctx = effectivePlannerReplyContext(args);
	if (!ctx) return true;
	if (ctx.source === "discord" && !ctx.addressed) return false;
	return ctx.addressed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function providerText(state: State | undefined, name: string): string {
	const data = asRecord(state?.data);
	const providers = asRecord(data?.providers);
	const provider = asRecord(providers?.[name]);
	const text = provider?.text;
	return typeof text === "string" ? text : "";
}

export function conversationText(state: State | undefined): string {
	const recent = state?.values?.recentMessages;
	const base = typeof recent === "string" && recent.trim().length > 0
		? recent
		: typeof state?.text === "string" && state.text.trim().length > 0
			? state.text
			: "";
	const discordContext = providerText(state, "DISCORD_CONTEXT");
	const telegramContext = providerText(state, "TELEGRAM_CONTEXT");
	return [base, discordContext, telegramContext].filter((t) => t.trim().length > 0).join("\n\n");
}

function cleanText(raw: string): string {
	let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
	const fenced = text.match(/^```(?:[a-z]+)?\s*([\s\S]*?)```$/i);
	if (fenced?.[1]) text = fenced[1].trim();
	const textLine = text.match(/^text\s*:\s*(.+)$/im);
	if (textLine?.[1]) text = textLine[1].trim();
	text = text.replace(/^["'`]+|["'`]+$/g, "").trim();
	return text.length > 2000 ? text.slice(0, 2000).trim() : text;
}

function isInternalFailureText(text: string): boolean {
	const lower = text.toLowerCase();
	return [
		"dynamicpromptexecfromstate",
		"reply generation failed",
		"provider path",
		"discord_generation_failed",
		"server_is_overloaded",
		"apikey=",
		"stack trace",
	].some((term) => lower.includes(term.toLowerCase()));
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		: [];
}

function characterReplyContext(runtime: IAgentRuntime): string {
	const character = runtime.character as {
		system?: unknown;
		bio?: unknown;
		lore?: unknown;
		style?: { all?: unknown; chat?: unknown };
	};
	const lines = [
		typeof character.system === "string" ? character.system.trim() : "",
		...stringArray(character.bio).slice(0, 4),
		...stringArray(character.lore).slice(0, 3),
		...stringArray(character.style?.all).slice(0, 4),
		...stringArray(character.style?.chat).slice(0, 4),
	].filter((line) => line.length > 0);
	return lines.join("\n").slice(0, CHARACTER_CONTEXT_LIMIT);
}

function collectAlwaysOnContext(
	runtime: IAgentRuntime,
	state: State | undefined,
): string {
	const raw = runtime.getSetting?.("ADDITIONAL_RESPONSE_STATE_PROVIDERS");
	if (typeof raw !== "string" || raw.length === 0) return "";
	const names = raw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	if (names.length === 0) return "";
	const blocks: string[] = [];
	for (const name of names) {
		const text = providerText(state, name).trim();
		if (text.length > 0) blocks.push(text);
	}
	return blocks.join("\n\n").slice(0, ALWAYS_ON_CONTEXT_LIMIT);
}

/**
 * Plain-text reply safety net. Called only when the freeform planner
 * AND the original eliza planner BOTH return null. Walks down model
 * tiers asking for free-form text; first non-empty answer wins.
 */
export async function generatePlainTextReply(
	runtime: IAgentRuntime,
	conversation: string,
	reason: string,
	memoryContext = "",
): Promise<string | null> {
	if (!conversation.trim()) return null;
	const attempts = [
		{ modelType: ModelType.TEXT_SMALL, compact: false, maxTokens: 500, temperature: 0.4 },
		{ modelType: ModelType.TEXT_MEDIUM, compact: true, maxTokens: 450, temperature: 0.35 },
		{ modelType: ModelType.TEXT_LARGE, compact: true, maxTokens: 450, temperature: 0.25 },
	];
	for (const attempt of attempts) {
		const prompt = plainTextReplyPrompt(runtime, conversation, memoryContext, attempt.compact);
		let raw: string;
		try {
			raw = await runtime.useModel(attempt.modelType, {
				prompt,
				maxTokens: attempt.maxTokens,
				temperature: attempt.temperature,
			});
		} catch (error) {
			runtime.logger.warn(
				{
					src: "detour:dpe-fallback",
					reason,
					modelType: attempt.modelType,
					error: error instanceof Error ? error.message : String(error),
				},
				"Plain-text reply attempt failed",
			);
			continue;
		}
		const text = typeof raw === "string" ? cleanText(raw) : "";
		if (!text.trim()) continue;
		if (isInternalFailureText(text)) {
			runtime.logger.warn(
				{ src: "detour:dpe-fallback", reason },
				"Suppressed internal failure text from plain-text reply",
			);
			return null;
		}
		return text;
	}
	return null;
}

function plainTextReplyPrompt(
	runtime: IAgentRuntime,
	conversation: string,
	memoryContext: string,
	compact: boolean,
): string {
	const characterContext = characterReplyContext(runtime);
	const trimmedMemory = memoryContext.trim();
	const conversationLimit = compact ? COMPACT_CONVERSATION_LIMIT : STANDARD_CONVERSATION_LIMIT;
	const memoryLimit = compact ? COMPACT_MEMORY_LIMIT : ALWAYS_ON_CONTEXT_LIMIT;
	return renderPromptTemplate(
		runtime,
		DETOUR_DPE_FALLBACK_TEMPLATE,
		{
			agentName: runtime.character.name ?? "Detour",
			characterContext: characterContext
				? `Character context:\n${characterContext}`
				: "",
			memoryContext: trimmedMemory
				? `${compact ? "Relevant context:" : "Memory and capability context (use anything relevant when answering):"}\n${trimmedMemory.slice(-memoryLimit)}`
				: "",
			conversation: conversation.slice(-conversationLimit),
		},
		DETOUR_DPE_FALLBACK_DEFAULT,
	);
}

async function fallbackPlannerReply(
	runtime: IAgentRuntime,
	args: DynamicPromptArgs,
	reason: string,
): Promise<DynamicPromptResult> {
	const text = await generatePlainTextReply(
		runtime,
		conversationText(args.state),
		reason,
		collectAlwaysOnContext(runtime, args.state),
	);
	if (!text) return null;
	return {
		thought: "Plain-text safety net",
		actions: ["REPLY"],
		providers: "",
		text,
		simple: true,
	};
}

/**
 * Quota-cap short-circuit reply. When the active provider is rate-
 * capped, every model call will 429 — there's no point chaining
 * through planners. Ship a clean "I'm capped, here's why" reply.
 */
function quotaCappedReply(cap: QuotaCap): DynamicPromptResult {
	const resetText = new Date(cap.resetsAtMs).toLocaleString();
	const text =
		`heads up — my active model provider (${cap.accountLabel}) hit its weekly cap. ` +
		`it resets ${resetText}. switch the active provider in Detour Settings → Models & Providers to keep me working until then, ` +
		`or wait for the reset. i'm not ignoring you — i literally can't plan or act until i have a working model.`;
	return {
		thought: `Active provider ${cap.accountLabel} is rate-capped until ${resetText}; short-circuiting.`,
		actions: ["REPLY"],
		providers: "",
		text,
		simple: true,
	};
}

// ── Companion pre-pass ─────────────────────────────────────────────
// Optional hook wired from core/index.ts when the companion service
// is available. Adds persona-framing + recent-messages compression
// to the planner state before it runs.

type CompanionPlannerHook = {
	personaPrePass?: (agentName: string, userText: string) => Promise<string | null>;
	compress?: (history: string, targetTokens?: number) => Promise<string | null>;
	triage?: (userText: string) => Promise<"chat" | "tool" | "search" | "complex" | "skip" | null>;
};

let companionPlannerHook: CompanionPlannerHook | null = null;

export function setCompanionPlannerHook(hook: CompanionPlannerHook | null): void {
	companionPlannerHook = hook;
}

function extractLastUserText(args: DynamicPromptArgs): string {
	const recent = args.state?.values?.recentMessages;
	if (typeof recent !== "string" || recent.length === 0) return "";
	const lines = recent.split("\n");
	for (let i = lines.length - 1; i -= 1, i >= 0;) {
		const line = lines[i] ?? "";
		const userMatch = line.match(/User:\s*(.+)$/);
		if (userMatch?.[1]) return userMatch[1].trim();
	}
	return "";
}

const COMPRESS_THRESHOLD_CHARS = 4_000;

async function applyCompanionPrePlannerPass(
	args: DynamicPromptArgs,
	agentName: string,
): Promise<DynamicPromptArgs> {
	if (!companionPlannerHook) return args;
	const userText = extractLastUserText(args);
	const recent = args.state?.values?.recentMessages;
	const shouldCompress =
		typeof recent === "string" && recent.length > COMPRESS_THRESHOLD_CHARS;

	const [frame, compressed] = await Promise.all([
		companionPlannerHook.personaPrePass && userText
			? companionPlannerHook.personaPrePass(agentName, userText).catch(() => null)
			: Promise.resolve(null),
		shouldCompress && companionPlannerHook.compress
			? companionPlannerHook.compress(recent as string, 250).catch(() => null)
			: Promise.resolve(null),
	]);

	if (!frame && !compressed) return args;

	const prevState = args.state;
	const nextValues: Record<string, unknown> = { ...(prevState?.values ?? {}) };
	if (frame) nextValues.detourCompanionFrame = frame;
	if (compressed) {
		nextValues.recentMessagesOriginal = recent;
		nextValues.recentMessages = `[compressed summary] ${compressed}`;
	}
	type StateShape = NonNullable<DynamicPromptArgs["state"]>;
	const nextState: StateShape = {
		...(prevState ?? ({ values: {}, data: {}, text: "" } as StateShape)),
		values: nextValues as StateShape["values"],
		data: prevState?.data ?? ({} as StateShape["data"]),
	};
	return { ...args, state: nextState };
}

// ── The wrapper ───────────────────────────────────────────────────

export function installDpeFallbackPatch(runtime: IAgentRuntime): void {
	const wrapped = runtime as WrappedRuntime;
	if (wrapped[WRAPPED]) return;
	const original = runtime.dynamicPromptExecFromState.bind(runtime);
	const agentName = runtime.character?.name ?? "agent";
	wrapped.dynamicPromptExecFromState = async (
		args: DynamicPromptArgs,
	): Promise<DynamicPromptResult> => {
		// Companion pre-pass: augment state additively. Failures fall through.
		const argsAfterCompanion = await applyCompanionPrePlannerPass(args, agentName);
		const canFallback = canUsePlainReply(argsAfterCompanion);

		// Quota-cap short-circuit. When the active credential is capped,
		// every retry will 429. Skip directly to the cap notice unless
		// the local-chat fallback is available (then let the planner
		// route through it).
		const activeCap = getProviderQuotaService().getActiveCap();
		const localChatAvailable =
			typeof process.env.DETOUR_LOCAL_CHAT_URL === "string" &&
			process.env.DETOUR_LOCAL_CHAT_URL.trim().length > 0;
		if (activeCap && canFallback && !localChatAvailable) {
			runtime.logger.warn(
				{
					src: "detour:dpe-fallback",
					providerId: activeCap.providerId,
					accountLabel: activeCap.accountLabel,
				},
				"Short-circuiting planner — active provider quota-capped",
			);
			return quotaCappedReply(activeCap);
		}

		try {
			const result = await original(argsAfterCompanion);
			if (result) return result;
			if (canFallback) {
				return await fallbackPlannerReply(runtime, argsAfterCompanion, "structured-null");
			}
			return result;
		} catch (err) {
			if (!canFallback) throw err;
			const fallback = await fallbackPlannerReply(
				runtime,
				argsAfterCompanion,
				err instanceof Error ? err.message : String(err),
			);
			if (fallback) return fallback;
			return null;
		}
	};
	wrapped[WRAPPED] = true;
}

export const dpeFallbackPlugin: Plugin = {
	name: "detour-dpe-fallback",
	description: "Companion pre-pass + quota-cap short-circuit + plain-text safety net (post free-form-planner).",
	init: (_config, runtime) => {
		installDpeFallbackPatch(runtime);
	},
};
