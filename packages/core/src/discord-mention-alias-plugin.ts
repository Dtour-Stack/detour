import type {
	HandlerCallback,
	IAgentRuntime,
	IMessageService,
	Memory,
	MessageProcessingOptions,
	MessageProcessingResult,
	Plugin,
} from "@elizaos/core";
import { runWithPlannerFallbackContext } from "./dpe-fallback-plugin";

const DEFAULT_ALIASES = ["Detour", "Detour Squirrel", "detour_squirrel"];
const WRAPPED = Symbol.for("detour.discordMentionAlias.wrapped");

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
		const mentionContext = message.content.mentionContext;
		const addressed = marked ||
			mentionContext?.isMention === true ||
			mentionContext?.isReply === true;
		return runWithPlannerFallbackContext(
			{ source: "discord", addressed },
			() => handleMessage(callRuntime, message, callback, options),
		);
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
	},
};
