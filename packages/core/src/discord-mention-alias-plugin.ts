import type {
	Content,
	HandlerCallback,
	IAgentRuntime,
	IMessageService,
	Memory,
	MessageProcessingOptions,
	MessageProcessingResult,
	Plugin,
	State,
} from "@elizaos/core";
import {
	generatePlainTextReply,
	runWithPlannerFallbackContext,
} from "./dpe-fallback-plugin";

const DEFAULT_ALIASES = ["Detour", "Detour Squirrel", "detour_squirrel"];
const WRAPPED = Symbol.for("detour.discordMentionAlias.wrapped");
const DISCORD_FALLBACK_TEXT = "I saw it. Reply pipeline tripped, but I am still here.";
const DEFAULT_REPLY_GUARD_MS = 12_000;
const DEFAULT_FALLBACK_GENERATION_MS = 10_000;

type TimeoutResult = "timeout";

type TrajectoryAction = {
	actionType: string;
	actionName: string;
	parameters: Record<string, string | number | boolean | null>;
	reasoning?: string;
	success: boolean;
	result?: Record<string, string | number | boolean | null>;
};

type TrajectoryLogger = {
	logLlmCall?: (params: {
		stepId: string;
		model: string;
		systemPrompt: string;
		userPrompt: string;
		response: string;
		temperature: number;
		maxTokens: number;
		purpose: string;
		actionType: string;
		latencyMs: number;
		roomId?: string;
		messageId?: string;
	}) => void;
	completeStep?: (
		trajectoryId: string,
		stepId: string,
		action: TrajectoryAction,
	) => void;
};

type WrappedMessageService = IMessageService & {
	[WRAPPED]?: true;
};

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function aliasPattern(alias: string): RegExp {
	return new RegExp(`(^|[^\\p{L}\\p{N}_])@?${escapeRegex(alias)}(?=$|[^\\p{L}\\p{N}_])`, "iu");
}

function configuredAliases(runtime: IAgentRuntime): string[] {
	const raw = runtime.getSetting("DISCORD_MENTION_ALIASES");
	const configured = typeof raw === "string"
		? raw.split(/[\n,]+/).map((item) => item.trim()).filter((item) => item.length > 0)
		: [];
	return [
		...configured,
		runtime.character.name,
		runtime.character.username,
		...DEFAULT_ALIASES,
	].filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function mentionsAlias(text: string | undefined, aliases: string[]): boolean {
	if (!text) return false;
	return aliases.some((alias) => aliasPattern(alias.trim()).test(text));
}

function markMention(runtime: IAgentRuntime, message: Memory): boolean {
	const content = message.content;
	if (content.source !== "discord") return false;
	if (content.mentionContext?.isMention === true) return false;
	if (content.mentionContext?.isReply === true) return false;
	if (!mentionsAlias(content.text, configuredAliases(runtime))) return false;
	content.mentionContext = {
		isMention: true,
		isReply: false,
		isThread: content.mentionContext?.isThread === true,
		mentionType: "platform_mention",
	};
	return true;
}

function isAddressedDiscordMessage(runtime: IAgentRuntime, message: Memory): boolean {
	const mentionContext = message.content.mentionContext;
	return message.content.source === "discord" && (
		mentionContext?.isMention === true ||
		mentionContext?.isReply === true ||
		mentionsAlias(message.content.text, configuredAliases(runtime))
	);
}

function fallbackConversation(message: Memory): string {
	const text = typeof message.content.text === "string" ? message.content.text.trim() : "";
	return text ? `Latest Discord message:\n${text}` : "";
}

function readPositiveMs(runtime: IAgentRuntime, key: string, fallback: number): number {
	const raw = runtime.getSetting(key);
	if (typeof raw !== "string") return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | TimeoutResult> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	try {
		return await Promise.race([
			promise,
			new Promise<TimeoutResult>((resolve) => {
				timer = setTimeout(() => resolve("timeout"), ms);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function stringId(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function trajectoryIds(message: Memory): { trajectoryId: string; stepId: string } | null {
	const meta = message.metadata;
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
	const bag = meta as Record<string, unknown>;
	const trajectoryId = stringId(bag.trajectoryId);
	const stepId = stringId(bag.trajectoryStepId);
	return trajectoryId && stepId ? { trajectoryId, stepId } : null;
}

function isTrajectoryLogger(value: unknown): value is TrajectoryLogger {
	if (!value || typeof value !== "object") return false;
	const candidate = value as TrajectoryLogger;
	return typeof candidate.logLlmCall === "function"
		|| typeof candidate.completeStep === "function";
}

function trajectoryLogger(runtime: IAgentRuntime): TrajectoryLogger | null {
	const direct = runtime.getService("trajectories");
	if (isTrajectoryLogger(direct)) return direct;
	const all = runtime.getServicesByType("trajectories");
	for (const service of all) {
		if (isTrajectoryLogger(service)) return service;
	}
	return null;
}

function recordFallbackTrajectory(
	runtime: IAgentRuntime,
	message: Memory,
	content: Content,
	reason: string,
	latencyMs: number,
	generatedByModel: boolean,
): void {
	const ids = trajectoryIds(message);
	if (!ids) return;
	const logger = trajectoryLogger(runtime);
	if (!logger) return;
	const text = typeof content.text === "string" ? content.text : "";
	if (generatedByModel) {
		logger.logLlmCall?.({
			stepId: ids.stepId,
			model: "TEXT_SMALL",
			systemPrompt: "",
			userPrompt: fallbackConversation(message),
			response: text,
			temperature: 0.4,
			maxTokens: 500,
			purpose: "response",
			actionType: "REPLY",
			latencyMs,
			roomId: String(message.roomId),
			messageId: stringId(message.id),
		});
	}
	logger.completeStep?.(ids.trajectoryId, ids.stepId, {
		actionType: "REPLY",
		actionName: "discord_fallback_reply",
		parameters: { reason },
		reasoning: typeof content.thought === "string" ? content.thought : undefined,
		success: true,
		result: { text },
	});
}

async function emitDiscordFallbackReply(
	runtime: IAgentRuntime,
	message: Memory,
	callback: HandlerCallback,
	reason: string,
): Promise<{ content: Content; memories: Memory[] }> {
	const startedAt = Date.now();
	const generated = await withTimeout(
		generatePlainTextReply(
			runtime,
			fallbackConversation(message),
			`discord-visible-reply:${reason}`,
		),
		readPositiveMs(runtime, "DISCORD_FALLBACK_GENERATION_MS", DEFAULT_FALLBACK_GENERATION_MS),
	);
	const generatedText = generated === "timeout" ? null : generated;
	const content: Content = {
		thought: "Discord visible reply guard",
		actions: ["REPLY"],
		text: generatedText ?? DISCORD_FALLBACK_TEXT,
		simple: true,
	};
	recordFallbackTrajectory(
		runtime,
		message,
		content,
		reason,
		Date.now() - startedAt,
		typeof generatedText === "string" && generatedText.length > 0,
	);
	runtime.logger.warn(
		{
			src: "detour:discord-reply-guard",
			reason,
			generatedByModel: typeof generatedText === "string" && generatedText.length > 0,
			messageId: message.id,
			roomId: message.roomId,
		},
		"Sending direct Discord fallback reply",
	);
	return { content, memories: await callback(content) };
}

function logLateHandlerFailure(runtime: IAgentRuntime, message: Memory, error: unknown): void {
	runtime.logger.warn(
		{
			src: "detour:discord-reply-guard",
			error: error instanceof Error ? error.message : String(error),
			messageId: message.id,
			roomId: message.roomId,
		},
		"Original Discord handler failed after fallback reply",
	);
}

function emptyState(): State {
	return { values: {}, data: {}, text: "" } as State;
}

export function installDiscordMentionAliasPatch(runtime: IAgentRuntime): void {
	const service = runtime.messageService as WrappedMessageService | null;
	if (!service || service[WRAPPED]) return;
	const handleMessage = service.handleMessage.bind(service);
	service.handleMessage = async (
		callRuntime: IAgentRuntime,
		message: Memory,
		callback?: HandlerCallback,
		options?: MessageProcessingOptions,
	): Promise<MessageProcessingResult> => {
		const marked = markMention(callRuntime, message);
		const addressed = marked || isAddressedDiscordMessage(callRuntime, message);
		let emittedVisibleContent = false;
		let fallbackEmitted = false;
		const trackingCallback: HandlerCallback | undefined = callback
			? async (content, actionName) => {
					if (fallbackEmitted) return [];
					const memories = await callback(content, actionName);
					if (memories.length > 0) emittedVisibleContent = true;
					return memories;
				}
			: undefined;
		const original = runWithPlannerFallbackContext(
			{ source: "discord", addressed },
			() => handleMessage(callRuntime, message, trackingCallback, options),
		);

		try {
			const result = addressed && callback
				? await withTimeout(
						original,
						readPositiveMs(callRuntime, "DISCORD_ADDRESSED_REPLY_GUARD_MS", DEFAULT_REPLY_GUARD_MS),
					)
				: await original;
			if (result === "timeout") {
				if (!callback) return await original;
				fallbackEmitted = true;
				void original.catch((error) => logLateHandlerFailure(callRuntime, message, error));
				const fallback = await emitDiscordFallbackReply(callRuntime, message, callback, "timeout");
				return {
					didRespond: true,
					responseContent: fallback.content,
					responseMessages: fallback.memories,
					state: emptyState(),
					mode: "simple",
				};
			}
			if (addressed && callback && !emittedVisibleContent) {
				fallbackEmitted = true;
				const fallback = await emitDiscordFallbackReply(callRuntime, message, callback, "empty-result");
				return {
					...result,
					didRespond: true,
					responseContent: fallback.content,
					responseMessages: fallback.memories,
					mode: "simple",
				};
			}
			return result;
		} catch (error) {
			if (!addressed || !callback) throw error;
			fallbackEmitted = true;
			const fallback = await emitDiscordFallbackReply(
				callRuntime,
				message,
				callback,
				error instanceof Error ? error.message : String(error),
			);
			return {
				didRespond: true,
				responseContent: fallback.content,
				responseMessages: fallback.memories,
				state: emptyState(),
				mode: "simple",
			};
		}
	};
	service[WRAPPED] = true;
}

export const discordMentionAliasPlugin: Plugin = {
	name: "detour-discord-mention-alias",
	description: "Treat Detour Discord aliases as addressed mentions.",
	init: (_config, runtime) => {
		installDiscordMentionAliasPatch(runtime);
		runtime.registerPipelineHook({
			id: "detour.discord_mention_alias",
			phase: "incoming_before_compose",
			position: -100,
			mutatesPrimary: true,
			handler: (_runtime, ctx) => {
				if (ctx.phase !== "incoming_before_compose") return;
				markMention(runtime, ctx.message);
			},
		});
		runtime.registerPipelineHook({
			id: "detour.discord_pre_should_respond_alias",
			phase: "pre_should_respond",
			position: -100,
			mutatesPrimary: true,
			handler: (_runtime, ctx) => {
				if (ctx.phase !== "pre_should_respond") return;
				markMention(runtime, ctx.message);
			},
		});
	},
};
