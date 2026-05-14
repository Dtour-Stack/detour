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
const COMPACT_STATE_TEXT_LIMIT = 2_500;
const COMPACT_PROVIDER_LIMIT = 900;
const COMPACT_PROMPT_FIELDS = new Set([
	"recentMessages",
	"providers",
	"actionNames",
	"actions",
	"knowledge",
	"facts",
]);

type DynamicPromptArgs = Parameters<IAgentRuntime["dynamicPromptExecFromState"]>[0];
type DynamicPromptResult = Awaited<ReturnType<IAgentRuntime["dynamicPromptExecFromState"]>>;
type WrappedRuntime = IAgentRuntime & {
	[WRAPPED]?: true;
};
type ProviderRecoveryTarget = {
	provider: "openrouter" | "elizacloud" | "anthropic" | "openai";
	envKey: "OPENROUTER_API_KEY" | "ELIZAOS_CLOUD_API_KEY" | "ANTHROPIC_API_KEY" | "OPENAI_API_KEY";
};

const PROVIDER_RECOVERY_TARGETS: ProviderRecoveryTarget[] = [
	{ provider: "openrouter", envKey: "OPENROUTER_API_KEY" },
	{ provider: "elizacloud", envKey: "ELIZAOS_CLOUD_API_KEY" },
	{ provider: "anthropic", envKey: "ANTHROPIC_API_KEY" },
	{ provider: "openai", envKey: "OPENAI_API_KEY" },
];

function isReplyLikeSchema(args: DynamicPromptArgs): boolean {
	const fields = new Set(args.schema.map((row) => row.field));
	for (const field of PLANNER_FIELDS) {
		if (!fields.has(field)) return false;
	}
	return true;
}

function normalizeReplyLikeSchema(args: DynamicPromptArgs): DynamicPromptArgs {
	if (!isReplyLikeSchema(args)) return args;
	let changed = false;
	const schema = args.schema.map((row) => {
		if (row.field === "actions") {
			const next = {
				...row,
				type: "array" as const,
				items: row.items ?? { description: "One action name or action entry" },
				required: false,
				validateField: false,
				streamField: false,
			};
			changed = changed || row.type !== next.type || row.required === true || row.items !== next.items || row.validateField !== false || row.streamField !== false;
			return next;
		}
		if (row.field === "providers") {
			const next = {
				...row,
				type: "string" as const,
				required: false,
				validateField: false,
				streamField: false,
			};
			changed = changed || row.type !== next.type || row.required === true || row.validateField !== false || row.streamField !== false;
			return next;
		}
		if (row.field === "thought" || row.field === "simple") {
			const next = {
				...row,
				required: false,
				validateField: false,
				streamField: false,
			};
			changed = changed || row.required === true || row.validateField !== false || row.streamField !== false;
			return next;
		}
		return row;
	});
	return changed ? { ...args, schema } : args;
}

function shouldUseCompactRetry(args: DynamicPromptArgs): boolean {
	return args.options?.modelType === ModelType.ACTION_PLANNER ||
		args.options?.modelType === ModelType.TEXT_LARGE ||
		isReplyLikeSchema(args) ||
		args.schema.length > 0;
}

function canUseCompactRetry(args: DynamicPromptArgs): boolean {
	if (!shouldUseCompactRetry(args)) return false;
	const ctx = effectivePlannerReplyContext(args);
	if ((ctx?.source === "discord" || ctx?.source === "telegram") && !ctx.addressed) return false;
	return true;
}

/** @deprecated Prefer `runWithPlannerReplyContext` from `@elizaos/core` (Telegram + Discord). */
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

/** ALS when available; else snapshot embedded in composed state for this turn. */
function effectivePlannerReplyContext(
	args: DynamicPromptArgs,
): { source: string; addressed: boolean } | undefined {
	return getPlannerReplyContext() ?? readPlannerReplyContextSnapshot(args.state);
}

function canUsePlainReply(args: DynamicPromptArgs): boolean {
	if (!isReplyLikeSchema(args)) return false;
	const ctx = effectivePlannerReplyContext(args);
	/** Legacy: no surface set context — keep permissive so older paths still get fallback. */
	if (!ctx) return true;
	/** Discord: only @-addressed turns use plain fallback (avoid spam in busy guilds). */
	if (ctx.source === "discord" && !ctx.addressed) return false;
	return ctx.addressed;
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
	return [base, discordContext, telegramContext].filter((text) => text.trim().length > 0).join("\n\n");
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

function trimMiddle(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const edge = Math.floor((limit - 32) / 2);
	return `${text.slice(0, edge)}\n[compact prompt state]\n${text.slice(-edge)}`;
}

function compactPromptValue(name: string, value: unknown): unknown {
	if (typeof value !== "string") return value;
	const lower = name.toLowerCase();
	const limit = COMPACT_PROMPT_FIELDS.has(name) || [...COMPACT_PROMPT_FIELDS].some((field) => lower.includes(field.toLowerCase()))
		? COMPACT_STATE_TEXT_LIMIT
		: COMPACT_PROVIDER_LIMIT;
	return trimMiddle(value, limit);
}

function compactRecordStrings(record: Record<string, unknown>): Record<string, unknown> {
	const next: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		next[key] = compactPromptValue(key, value);
	}
	return next;
}

function compactState(state: State | undefined): State | undefined {
	if (!state) return undefined;
	const next = { ...state } as State;
	next.text = typeof state.text === "string" ? trimMiddle(state.text, COMPACT_STATE_TEXT_LIMIT) : state.text;
	const values = asRecord(state.values);
	if (values) {
		next.values = compactRecordStrings(values) as State["values"];
	}
	const data = asRecord(state.data);
	if (data) {
		const nextData: Record<string, unknown> = { ...data };
		const providers = asRecord(data.providers);
		if (providers) {
			const nextProviders: Record<string, unknown> = {};
			for (const [name, provider] of Object.entries(providers)) {
				const record = asRecord(provider);
				nextProviders[name] = record && typeof record.text === "string"
					? { ...record, text: trimMiddle(record.text, COMPACT_PROVIDER_LIMIT) }
					: provider;
			}
			nextData.providers = nextProviders;
		}
		next.data = nextData as State["data"];
	}
	return next;
}

function compactRetryArgs(args: DynamicPromptArgs): DynamicPromptArgs {
	const nextOptions = {
		...args.options,
		modelType: args.options?.modelType === ModelType.TEXT_LARGE ? ModelType.TEXT_MEDIUM : args.options?.modelType,
		preferredEncapsulation: "json" as const,
		forceFormat: "json" as const,
		maxRetries: 0,
		contextCheckLevel: 0 as const,
		checkpointCodes: false,
		onStreamChunk: undefined,
	};
	return {
		...args,
		state: compactState(args.state),
		options: nextOptions,
	};
}

function providerRecoveryArgs(args: DynamicPromptArgs, provider: ProviderRecoveryTarget["provider"]): DynamicPromptArgs {
	const compact = compactRetryArgs(args);
	return {
		...compact,
		options: {
			...compact.options,
			model: provider,
		},
	};
}

function configuredProviderRecoveryTargets(runtime: IAgentRuntime, args: DynamicPromptArgs): ProviderRecoveryTarget[] {
	const activeProvider = typeof args.options?.model === "string" ? args.options.model : "";
	return PROVIDER_RECOVERY_TARGETS.filter((target) => {
		if (target.provider === activeProvider) return false;
		const setting = runtime.getSetting?.(target.envKey);
		if (typeof setting === "string" && setting.length > 0) return true;
		const env = process.env[target.envKey];
		return typeof env === "string" && env.length > 0;
	});
}

function structuredFailureText(args: DynamicPromptArgs, reason: string): string {
	const data = asRecord(args.state?.data);
	const values = asRecord(args.state?.values);
	const failure = asRecord(data?.structuredOutputFailure);
	const parts = [
		reason,
		typeof values?.structuredOutputFailureSummary === "string" ? values.structuredOutputFailureSummary : "",
		typeof failure?.kind === "string" ? failure.kind : "",
		typeof failure?.parseError === "string" ? failure.parseError : "",
		typeof failure?.responsePreview === "string" ? failure.responsePreview : "",
	].filter((part) => part.length > 0);
	return parts.join("\n").toLowerCase();
}

function canUseProviderRecovery(args: DynamicPromptArgs, reason: string): boolean {
	const text = structuredFailureText(args, reason);
	if (!text) return reason.length > 0;
	if (reason.length > 0) return true;
	return [
		"model_error",
		"503",
		"timeout",
		"timed out",
		"upstream",
		"disconnect",
		"reset",
		"connection",
		"no output",
		"empty",
	].some((needle) => text.includes(needle));
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
		"apiKey=",
		"stack trace",
	].some((term) => lower.includes(term.toLowerCase()));
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
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

/**
 * Pulls the rendered text for each Detour always-on provider out of the
 * composed state. Without this, the plain-text fallback strips every
 * memory + capability provider the runtime worked to assemble (character
 * anchor, capabilities snapshot, coding brief, skill catalog, user-activity
 * observations, facts, relationships) and the agent loses its identity +
 * memory the moment the structured planner errors out. This is exactly
 * when grounding matters most — model fail-overs are also the cases where
 * the user is most likely to notice the agent "forgetting" itself.
 *
 * Names are read from the `ADDITIONAL_RESPONSE_STATE_PROVIDERS` runtime
 * setting (the same one `composeResponseState` consults), so the fallback
 * always sees exactly what we configured as always-on, with no hard-coded
 * list to drift out of sync.
 */
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
					compact: attempt.compact,
					error: error instanceof Error ? error.message : String(error),
				},
				"Plain-text planner fallback model attempt failed",
			);
			continue;
		}
		const text = typeof raw === "string" ? cleanText(raw) : "";
		if (!text.trim()) continue;
		if (isInternalFailureText(text)) {
			runtime.logger.warn(
				{ src: "detour:dpe-fallback", reason },
				"Suppressed internal failure text from plain-text fallback",
			);
			return null;
		}
		runtime.logger.warn(
			{ src: "detour:dpe-fallback", reason },
			"Using plain-text planner fallback",
		);
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
		thought: "Plain-text planner fallback",
		actions: ["REPLY"],
		providers: "",
		text,
		simple: true,
	};
}

/**
 * Short-circuit reply for the "active provider is rate-capped" case.
 *
 * When `ProviderQuotaService` has an active cap recorded, every subsequent
 * model call will 429 with `usage_limit_reached`. There's no point retrying
 * the structured planner, the compact retry, or the plain-text fallback —
 * they all route through the same exhausted provider and all fail.
 *
 * Instead we deliver a clean system reply naming the cap, when it resets,
 * and what the user can do about it (switch provider in Settings). The
 * structured planner result keeps `actions: ["REPLY"]` so eliza's response
 * pipeline ships the text through whichever connector the turn came from
 * (Telegram, Discord, in-app chat, etc).
 *
 * Returning `null` here is the wrong call — it leaves the user staring at a
 * silent agent for ~5 days. A clear "I'm capped, here's why, here's the fix"
 * reply is the right escalation.
 */
function quotaCappedReply(cap: QuotaCap): DynamicPromptResult {
	const resetText = new Date(cap.resetsAtMs).toLocaleString();
	const text =
		`heads up — my active model provider (${cap.accountLabel}) hit its weekly cap. ` +
		`it resets ${resetText}. switch the active provider in Detour Settings → Providers to keep me working until then, ` +
		`or wait for the reset. i'm not ignoring you — i literally can't plan or act until i have a working model.`;
	return {
		thought: `Active provider ${cap.accountLabel} is rate-capped until ${resetText}; short-circuiting planner.`,
		actions: ["REPLY"],
		providers: "",
		text,
		simple: true,
	};
}

export function installDpeFallbackPatch(runtime: IAgentRuntime): void {
	const wrapped = runtime as WrappedRuntime;
	if (wrapped[WRAPPED]) return;
	const original = runtime.dynamicPromptExecFromState.bind(runtime);
	wrapped.dynamicPromptExecFromState = async (
		args: DynamicPromptArgs,
	): Promise<DynamicPromptResult> => {
		const structuredArgs = normalizeReplyLikeSchema(args);
		const canFallback = canUsePlainReply(structuredArgs);
		const shouldCompactRetry = canUseCompactRetry(structuredArgs);
		// Quota-cap short-circuit: if the active credential is already capped,
		// every retry tier (structured → compact → plain-text) will 429 on the
		// same exhausted upstream. Skip them and ship the cap notice directly
		// so the user actually hears about it instead of getting silence.
		const activeCap = getProviderQuotaService().getActiveCap();
		if (activeCap && canFallback) {
			runtime.logger.warn(
				{
					src: "detour:dpe-fallback",
					providerId: activeCap.providerId,
					accountLabel: activeCap.accountLabel,
					resetsAt: new Date(activeCap.resetsAtMs).toISOString(),
				},
				"Short-circuiting planner — active provider is quota-capped",
			);
			return quotaCappedReply(activeCap);
		}
		let failureReason = "structured-null";
		let compactAttempted = false;
		const runCompactRetry = async (): Promise<DynamicPromptResult> => {
			compactAttempted = true;
			try {
				const compactResult = await original(compactRetryArgs(structuredArgs));
				if (compactResult) {
					runtime.logger.warn(
						{ src: "detour:dpe-fallback", reason: failureReason },
						"Using compact dynamic prompt retry",
					);
				}
				return compactResult;
			} catch (compactError) {
				runtime.logger.warn(
					{
						src: "detour:dpe-fallback",
						reason: failureReason,
						error: compactError instanceof Error ? compactError.message : String(compactError),
					},
					"Compact dynamic prompt retry failed",
				);
				return null;
			}
		};
		const runProviderRecovery = async (): Promise<DynamicPromptResult> => {
			if (!shouldCompactRetry || !canUseProviderRecovery(structuredArgs, failureReason)) return null;
			for (const target of configuredProviderRecoveryTargets(runtime, structuredArgs)) {
				try {
					const providerResult = await original(providerRecoveryArgs(structuredArgs, target.provider));
					if (providerResult) {
						runtime.logger.warn(
							{ src: "detour:dpe-fallback", reason: failureReason, provider: target.provider },
							"Using provider recovery for dynamic prompt retry",
						);
						return providerResult;
					}
				} catch (providerError) {
					runtime.logger.warn(
						{
							src: "detour:dpe-fallback",
							reason: failureReason,
							provider: target.provider,
							error: providerError instanceof Error ? providerError.message : String(providerError),
						},
						"Provider recovery dynamic prompt retry failed",
					);
				}
			}
			return null;
		};
		try {
			const result = await original(structuredArgs);
			if (result) return result;
			if (!canFallback && !shouldCompactRetry) return result;
			if (shouldCompactRetry) {
				const compact = await runCompactRetry();
				if (compact) return compact;
			}
			const providerRecovery = await runProviderRecovery();
			if (providerRecovery) return providerRecovery;
			if (canFallback) return await fallbackPlannerReply(runtime, structuredArgs, "structured-null");
		} catch (error) {
			failureReason = error instanceof Error ? error.message : String(error);
			if (!canFallback && !shouldCompactRetry) throw error;
			if (shouldCompactRetry) {
				const compact = await runCompactRetry();
				if (compact) return compact;
			}
			const providerRecovery = await runProviderRecovery();
			if (providerRecovery) return providerRecovery;
			if (canFallback) {
				const fallback = await fallbackPlannerReply(
					runtime,
					structuredArgs,
					failureReason,
				);
				if (fallback) return fallback;
			}
		}
		if (shouldCompactRetry && !compactAttempted) {
			return await runCompactRetry();
		}
		return null;
	};
	wrapped[WRAPPED] = true;
}

export const dpeFallbackPlugin: Plugin = {
	name: "detour-dpe-fallback",
	description: "Keeps message replies flowing when structured response planning fails.",
	init: (_config, runtime) => {
		installDpeFallbackPatch(runtime);
	},
};
