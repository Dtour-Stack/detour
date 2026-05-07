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
import { createUniqueUuid, EventType } from "@elizaos/core";
import {
	generatePlainTextReply,
	runWithPlannerFallbackContext,
} from "./dpe-fallback-plugin";

const DEFAULT_ALIASES = ["Detour", "Detour Squirrel", "detour_squirrel"];
const WRAPPED = Symbol.for("detour.discordMentionAlias.wrapped");
const MANAGER_WRAPPED = Symbol.for("detour.discordMessageManagerGuard.wrapped");
const DISCORD_FALLBACK_TEXTS = [
	"I saw it. Had to kick the door open for a second, but I am here.",
	"I caught the tag. Give me one clean second and I am back in the room.",
	"Yeah, I am here. Short stumble, still standing.",
	"I saw the callout. The quiet part is over.",
	"I caught it. Took the scenic route back, but I am not missing this.",
] as const;
const DEFAULT_REPLY_GUARD_MS = 45_000;
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

type DiscordUserLike = {
	id?: string;
	username?: string | null;
	displayName?: string | null;
	globalName?: string | null;
	tag?: string | null;
	bot?: boolean;
};

type DiscordCollectionLike<T> = {
	has?: (id: string) => boolean;
	values?: () => IterableIterator<T> | Iterable<T>;
};

type DiscordMessageLike = {
	id?: string;
	content?: string;
	createdTimestamp?: number;
	author?: DiscordUserLike;
	mentions?: {
		users?: DiscordCollectionLike<DiscordUserLike>;
		repliedUser?: DiscordUserLike | null;
	};
	reference?: { messageId?: string };
	channel?: {
		id?: string;
		send?: (payload: unknown) => Promise<unknown>;
		messages?: {
			fetch?: (options: { limit: number }) => Promise<DiscordCollectionLike<DiscordMessageLike>>;
		};
	};
	reply?: (payload: unknown) => Promise<unknown>;
};

type DiscordMessageManagerLike = {
	[MANAGER_WRAPPED]?: true;
	handleMessage: (message: DiscordMessageLike) => Promise<unknown>;
};

type DiscordServiceLike = {
	client?: { user?: DiscordUserLike | null };
	messageManager?: DiscordMessageManagerLike;
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

function configuredDiscordAliases(runtime: IAgentRuntime, user: DiscordUserLike | null | undefined): string[] {
	return [
		...configuredAliases(runtime),
		user?.username,
		user?.globalName,
		user?.tag,
	].filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function mentionsAlias(text: string | undefined, aliases: string[]): boolean {
	if (!text) return false;
	return aliases.some((alias) => aliasPattern(alias.trim()).test(text));
}

function isDiscordMessage(message: Memory): boolean {
	if (message.content.source === "discord") return true;
	const meta = message.metadata;
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return false;
	const bag = meta as Record<string, unknown>;
	return bag.source === "discord"
		|| bag.provider === "discord"
		|| bag.discord !== undefined
		|| bag.discordMessageId !== undefined
		|| bag.discordChannelId !== undefined;
}

function markMention(runtime: IAgentRuntime, message: Memory): boolean {
	const content = message.content;
	if (!isDiscordMessage(message)) return false;
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
	return isDiscordMessage(message) && (
		mentionContext?.isMention === true ||
		mentionContext?.isReply === true ||
		mentionsAlias(message.content.text, configuredAliases(runtime))
	);
}

function fallbackConversation(message: Memory): string {
	const text = typeof message.content.text === "string" ? message.content.text.trim() : "";
	return text ? `Latest Discord message:\n${text}` : "";
}

function rawDiscordText(message: DiscordMessageLike): string {
	const text = typeof message.content === "string" ? message.content.trim() : "";
	return text.length > 0 ? text : "";
}

function discordAuthorName(message: DiscordMessageLike, botUser: DiscordUserLike | null | undefined): string {
	if (botUser?.id && message.author?.id === botUser.id) return "Detour Squirrel";
	return message.author?.displayName
		?? message.author?.globalName
		?? message.author?.username
		?? message.author?.tag
		?? message.author?.id
		?? "Unknown";
}

function rawDiscordLine(message: DiscordMessageLike, botUser: DiscordUserLike | null | undefined): string | null {
	const text = rawDiscordText(message);
	if (!text) return null;
	return `${discordAuthorName(message, botUser)}: ${text}`;
}

async function rawFallbackConversation(
	runtime: IAgentRuntime,
	message: DiscordMessageLike,
	botUser: DiscordUserLike | null | undefined,
): Promise<string> {
	const seen = new Set<string>();
	const messages: DiscordMessageLike[] = [];
	try {
		const fetched = await message.channel?.messages?.fetch?.({ limit: 12 });
		for (const item of collectionValues(fetched)) {
			if (item.id && seen.has(item.id)) continue;
			if (item.id) seen.add(item.id);
			messages.push(item);
		}
	} catch (error) {
		runtime.logger.warn(
			{
				src: "detour:discord-manager-guard",
				messageId: message.id,
				channelId: message.channel?.id,
				error: error instanceof Error ? error.message : String(error),
			},
			"Could not fetch Discord history for generated reply context",
		);
	}
	if (!message.id || !seen.has(message.id)) messages.push(message);
	const lines = messages
		.sort((a, b) => (a.createdTimestamp ?? 0) - (b.createdTimestamp ?? 0))
		.flatMap((item) => {
			const line = rawDiscordLine(item, botUser);
			return line ? [line] : [];
		})
		.slice(-12);
	return lines.length > 0
		? [
				"Recent Discord channel context:",
				...lines,
				"",
				"Reply to the latest user message. Use prior turns when they clarify what the user means.",
			].join("\n")
		: "";
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

function fallbackHash(seed: string): number {
	let hash = 2_166_136_261;
	for (let i = 0; i < seed.length; i += 1) {
		hash ^= seed.charCodeAt(i);
		hash = Math.imul(hash, 16_777_619);
	}
	return hash >>> 0;
}

function fallbackText(seed: string | undefined): string {
	if (!seed) return DISCORD_FALLBACK_TEXTS[0];
	return DISCORD_FALLBACK_TEXTS[fallbackHash(seed) % DISCORD_FALLBACK_TEXTS.length];
}

function memoryFallbackSeed(message: Memory): string | undefined {
	return stringId(message.id) ?? stringId(message.content.text);
}

function rawFallbackSeed(message: DiscordMessageLike): string | undefined {
	return stringId(message.id) ?? stringId(message.content);
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

function isDiscordService(value: unknown): value is DiscordServiceLike {
	if (!value || typeof value !== "object") return false;
	const service = value as DiscordServiceLike;
	return typeof service.messageManager?.handleMessage === "function";
}

function discordService(runtime: IAgentRuntime): DiscordServiceLike | null {
	const direct = runtime.getService("discord");
	if (isDiscordService(direct)) return direct;
	const all = runtime.getServicesByType("discord");
	for (const service of all) {
		if (isDiscordService(service)) return service;
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
		text: generatedText ?? fallbackText(memoryFallbackSeed(message)),
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

function rawMessageAddressesBot(
	runtime: IAgentRuntime,
	message: DiscordMessageLike,
	botUser: DiscordUserLike | null | undefined,
): boolean {
	const botId = stringId(botUser?.id);
	if (message.author?.bot || (botId && message.author?.id === botId)) return false;
	const mentionsBot = botId
		? message.mentions?.users?.has?.(botId) === true ||
			message.content?.includes(`<@${botId}>`) === true ||
			message.content?.includes(`<@!${botId}>`) === true
		: false;
	const repliesToBot = botId && message.reference?.messageId && message.mentions?.repliedUser?.id === botId;
	return mentionsBot || repliesToBot === true || mentionsAlias(message.content, configuredDiscordAliases(runtime, botUser));
}

function collectionValues<T>(collection: DiscordCollectionLike<T> | undefined): T[] {
	if (!collection?.values) return [];
	return Array.from(collection.values());
}

async function hasRecentBotReply(message: DiscordMessageLike, botId: string | undefined): Promise<boolean> {
	if (!botId || !message.channel?.messages?.fetch) return false;
	const fetched = await message.channel.messages.fetch({ limit: 25 }).catch(() => null);
	const createdAt = message.createdTimestamp ?? 0;
	for (const candidate of collectionValues(fetched ?? undefined)) {
		if (candidate.author?.id !== botId) continue;
		if (candidate.reference?.messageId === message.id) return true;
		const replyAt = candidate.createdTimestamp ?? 0;
		if (createdAt > 0 && replyAt > createdAt && replyAt - createdAt <= 5 * 60_000) return true;
	}
	return false;
}

async function directDiscordFallbackContent(
	runtime: IAgentRuntime,
	service: DiscordServiceLike,
	message: DiscordMessageLike,
	reason: string,
): Promise<Content> {
	const conversation = await rawFallbackConversation(runtime, message, service.client?.user);
	const generated = await withTimeout(
		generatePlainTextReply(
			runtime,
			conversation,
			`discord-manager-visible-reply:${reason}`,
		),
		readPositiveMs(runtime, "DISCORD_FALLBACK_GENERATION_MS", DEFAULT_FALLBACK_GENERATION_MS),
	);
	const text = generated === "timeout" ? null : generated;
	return {
		thought: "Discord manager visible reply guard",
		actions: ["REPLY"],
		text: text ?? fallbackText(rawFallbackSeed(message)),
		simple: true,
	};
}

async function sendDirectDiscordFallback(message: DiscordMessageLike, content: Content): Promise<void> {
	const text = typeof content.text === "string" ? content.text.trim() : "";
	if (!text) return;
	const payload = {
		content: text,
		allowedMentions: { repliedUser: false },
	};
	if (typeof message.reply === "function") {
		await message.reply(payload);
		return;
	}
	await message.channel?.send?.({
		...payload,
		...(message.id ? { reply: { messageReference: message.id, failIfNotExists: false } } : {}),
	});
}

function emitDirectDiscordFallbackSent(
	runtime: IAgentRuntime,
	message: DiscordMessageLike,
	content: Content,
): void {
	const channelId = stringId(message.channel?.id);
	const messageId = stringId(message.id);
	if (!channelId || !messageId) return;
	const roomId = createUniqueUuid(runtime, channelId);
	const reply: Memory = {
		id: createUniqueUuid(runtime, `discord-manager-fallback:${messageId}:${Date.now()}`),
		entityId: runtime.agentId,
		agentId: runtime.agentId,
		roomId,
		content: {
			...content,
			source: "discord",
			inReplyTo: createUniqueUuid(runtime, messageId),
		},
		createdAt: Date.now(),
	} as Memory;
	void runtime.emitEvent(EventType.MESSAGE_SENT, {
		runtime,
		message: reply,
		source: "discord",
	});
}

async function handleManagerFallback(
	runtime: IAgentRuntime,
	service: DiscordServiceLike,
	message: DiscordMessageLike,
	reason: string,
): Promise<void> {
	const botId = stringId(service.client?.user?.id);
	if (await hasRecentBotReply(message, botId)) return;
	const content = await directDiscordFallbackContent(runtime, service, message, reason);
	await sendDirectDiscordFallback(message, content);
	emitDirectDiscordFallbackSent(runtime, message, content);
	runtime.logger.warn(
		{
			src: "detour:discord-manager-guard",
			reason,
			messageId: message.id,
			channelId: message.channel?.id,
		},
		"Sent direct Discord manager fallback reply",
	);
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

export function installDiscordMessageManagerGuard(runtime: IAgentRuntime): void {
	const service = discordService(runtime);
	const manager = service?.messageManager;
	if (!service || !manager || manager[MANAGER_WRAPPED]) return;
	const handleMessage = manager.handleMessage.bind(manager);
	manager.handleMessage = async (message: DiscordMessageLike): Promise<unknown> => {
		if (!rawMessageAddressesBot(runtime, message, service.client?.user)) {
			return await handleMessage(message);
		}
		const original = handleMessage(message);
		try {
			const result = await withTimeout(
				original,
				readPositiveMs(runtime, "DISCORD_ADDRESSED_REPLY_GUARD_MS", DEFAULT_REPLY_GUARD_MS),
			);
			if (result === "timeout") {
				void original.catch((error) =>
					runtime.logger.warn(
						{
							src: "detour:discord-manager-guard",
							error: error instanceof Error ? error.message : String(error),
							messageId: message.id,
							channelId: message.channel?.id,
						},
						"Original Discord manager handler failed after fallback reply",
					),
				);
				await handleManagerFallback(runtime, service, message, "timeout");
				return undefined;
			}
			await handleManagerFallback(runtime, service, message, "empty-manager-result");
			return result;
		} catch (error) {
			await handleManagerFallback(
				runtime,
				service,
				message,
				error instanceof Error ? error.message : String(error),
			);
			return undefined;
		}
	};
	manager[MANAGER_WRAPPED] = true;
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
