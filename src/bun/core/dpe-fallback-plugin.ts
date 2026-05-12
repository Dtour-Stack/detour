import {
	getPlannerReplyContext,
	PLANNER_REPLY_CONTEXT_SNAPSHOT_STATE_KEY,
	type IAgentRuntime,
	ModelType,
	type Plugin,
	runWithPlannerReplyContext,
	type State,
} from "@elizaos/core";

const WRAPPED = Symbol.for("detour.dpeFallback.wrapped");
const PLANNER_FIELDS = new Set(["thought", "actions", "providers", "text", "simple"]);

type DynamicPromptArgs = Parameters<IAgentRuntime["dynamicPromptExecFromState"]>[0];
type DynamicPromptResult = Awaited<ReturnType<IAgentRuntime["dynamicPromptExecFromState"]>>;
type WrappedRuntime = IAgentRuntime & {
	[WRAPPED]?: true;
};

function isResponsePlanner(args: DynamicPromptArgs): boolean {
	if (args.options?.modelType !== ModelType.ACTION_PLANNER) return false;
	const fields = new Set(args.schema.map((row) => row.field));
	for (const field of PLANNER_FIELDS) {
		if (!fields.has(field)) return false;
	}
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
	if (!isResponsePlanner(args)) return false;
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
	return lines.join("\n").slice(0, 5_000);
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
	return blocks.join("\n\n").slice(0, 12_000);
}

export async function generatePlainTextReply(
	runtime: IAgentRuntime,
	conversation: string,
	reason: string,
	memoryContext = "",
): Promise<string | null> {
	if (!conversation.trim()) return null;
	const characterContext = characterReplyContext(runtime);
	const trimmedMemory = memoryContext.trim();
	const prompt = [
		`You are ${runtime.character.name}. Reply to the latest user message in plain text.`,
		"Return only the message to send. No labels, no JSON, no TOON, no markdown fence, no hidden reasoning.",
		...(characterContext ? ["", "Character context:", characterContext] : []),
		...(trimmedMemory
			? ["", "Memory and capability context (use anything relevant when answering):", trimmedMemory]
			: []),
		"",
		"Recent conversation:",
		conversation.slice(-12_000),
		"",
		"Reply:",
	].join("\n");
	try {
		let raw = await runtime.useModel(ModelType.TEXT_SMALL, {
			prompt,
			maxTokens: 500,
			temperature: 0.4,
		});
		let text = typeof raw === "string" ? cleanText(raw) : "";
		if (!text.trim()) {
			raw = await runtime.useModel(ModelType.TEXT_MEDIUM, {
				prompt,
				maxTokens: 500,
				temperature: 0.35,
			});
			text = typeof raw === "string" ? cleanText(raw) : "";
		}
		if (!text.trim()) {
			raw = await runtime.useModel(ModelType.TEXT_LARGE, {
				prompt,
				maxTokens: 500,
				temperature: 0.25,
			});
			text = typeof raw === "string" ? cleanText(raw) : "";
		}
		if (!text) return null;
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
	} catch (error) {
		runtime.logger.warn(
			{
				src: "detour:dpe-fallback",
				reason,
				error: error instanceof Error ? error.message : String(error),
			},
			"Plain-text planner fallback failed",
		);
		return null;
	}
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

export function installDpeFallbackPatch(runtime: IAgentRuntime): void {
	const wrapped = runtime as WrappedRuntime;
	if (wrapped[WRAPPED]) return;
	const original = runtime.dynamicPromptExecFromState.bind(runtime);
	wrapped.dynamicPromptExecFromState = async (
		args: DynamicPromptArgs,
	): Promise<DynamicPromptResult> => {
		const canFallback = canUsePlainReply(args);
		try {
			const result = await original(args);
			if (result || !canFallback) return result;
			return await fallbackPlannerReply(runtime, args, "structured-null");
		} catch (error) {
			if (!canFallback) throw error;
			const fallback = await fallbackPlannerReply(
				runtime,
				args,
				error instanceof Error ? error.message : String(error),
			);
			if (fallback) return fallback;
			return null;
		}
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
