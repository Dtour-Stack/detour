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

async function emitDiscordFallbackReply(
	runtime: IAgentRuntime,
	message: Memory,
	callback: HandlerCallback,
	reason: string,
): Promise<{ content: Content; memories: Memory[] }> {
	const generated = await generatePlainTextReply(
		runtime,
		fallbackConversation(message),
		`discord-visible-reply:${reason}`,
	);
	const content: Content = {
		thought: "Discord visible reply guard",
		actions: ["REPLY"],
		text: generated ?? DISCORD_FALLBACK_TEXT,
		simple: true,
	};
	runtime.logger.warn(
		{
			src: "detour:discord-reply-guard",
			reason,
			messageId: message.id,
			roomId: message.roomId,
		},
		"Sending direct Discord fallback reply",
	);
	return { content, memories: await callback(content) };
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
		const trackingCallback: HandlerCallback | undefined = callback
			? async (content, actionName) => {
					const memories = await callback(content, actionName);
					if (memories.length > 0) emittedVisibleContent = true;
					return memories;
				}
			: undefined;

		try {
			const result = await runWithPlannerFallbackContext(
				{ source: "discord", addressed },
				() => handleMessage(callRuntime, message, trackingCallback, options),
			);
			if (addressed && callback && !emittedVisibleContent) {
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
