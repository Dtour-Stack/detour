import {
	type IAgentRuntime,
	ModelType,
	type Plugin,
	type State,
} from "@elizaos/core";
import { AsyncLocalStorage } from "node:async_hooks";

const WRAPPED = Symbol.for("detour.dpeFallback.wrapped");
const PLANNER_FIELDS = new Set(["thought", "actions", "providers", "text", "simple"]);
const plannerContext = new AsyncLocalStorage<{ source: string; addressed: boolean }>();

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

export function runWithPlannerFallbackContext<T>(
	context: { source: string; addressed: boolean },
	run: () => T,
): T {
	return plannerContext.run(context, run);
}

function shouldUsePlainReply(args: DynamicPromptArgs): boolean {
	const context = plannerContext.getStore();
	return isResponsePlanner(args) && context?.source === "discord" && context.addressed;
}

export function conversationText(state: State | undefined): string {
	const recent = state?.values?.recentMessages;
	if (typeof recent === "string" && recent.trim().length > 0) return recent;
	if (typeof state?.text === "string" && state.text.trim().length > 0) return state.text;
	return "";
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

export async function generatePlainTextReply(
	runtime: IAgentRuntime,
	conversation: string,
	reason: string,
): Promise<string | null> {
	if (!conversation.trim()) return null;
	const prompt = [
		`You are ${runtime.character.name}. Reply to the latest user message in plain text.`,
		"Return only the message to send. No labels, no JSON, no TOON, no markdown fence, no hidden reasoning.",
		"",
		"Recent conversation:",
		conversation.slice(-12_000),
		"",
		"Reply:",
	].join("\n");
	try {
		const raw = await runtime.useModel(ModelType.TEXT_SMALL, {
			prompt,
			maxTokens: 500,
			temperature: 0.4,
		});
		const text = typeof raw === "string" ? cleanText(raw) : "";
		if (!text) return null;
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
	const text = await generatePlainTextReply(runtime, conversationText(args.state), reason);
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
		if (shouldUsePlainReply(args)) {
			const fallback = await fallbackPlannerReply(runtime, args, "discord-addressed");
			if (fallback) return fallback;
		}
		try {
			const result = await original(args);
			if (result || !isResponsePlanner(args)) return result;
			return await fallbackPlannerReply(runtime, args, "structured-null");
		} catch (error) {
			if (!isResponsePlanner(args)) throw error;
			const fallback = await fallbackPlannerReply(
				runtime,
				args,
				error instanceof Error ? error.message : String(error),
			);
			if (fallback) return fallback;
			throw error;
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
