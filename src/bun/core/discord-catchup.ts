import type { IAgentRuntime } from "@elizaos/core";

const DEFAULT_LIMIT = 100;
const DEFAULT_MAX_AGE_MS = 6 * 60 * 60_000;
const BOT_REPLY_WINDOW_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const HANDLE_TIMEOUT_MS = 180_000;
const DEFAULT_ALIASES = ["Detour", "Detour Squirrel", "detour_squirrel"];

export type DiscordCatchUpOptions = {
	channelId?: string;
	limit?: number;
	maxAgeMs?: number;
};

export type DiscordCatchUpResult = {
	channelsScanned: number;
	messagesScanned: number;
	addressed: number;
	alreadyAnswered: number;
	replied: number;
	errors: number;
	errorDetails: Array<{ channelId: string; channelName?: string; error: string }>;
};

type DiscordUserLike = {
	id?: string;
	username?: string;
	globalName?: string | null;
	tag?: string;
	bot?: boolean;
};

type DiscordMentionUsersLike = { has?: (id: string) => boolean };

type DiscordMessageLike = {
	id?: string;
	content?: string;
	createdTimestamp?: number;
	author?: DiscordUserLike;
	mentions?: {
		users?: DiscordMentionUsersLike;
		repliedUser?: DiscordUserLike | null;
	};
	reference?: { messageId?: string | null } | null;
	interaction?: unknown;
};

type DiscordMessageCollectionLike = {
	values: () => Iterable<DiscordMessageLike>;
};

type DiscordTextChannelLike = {
	id: string;
	name?: string;
	isTextBased?: () => boolean;
	isVoiceBased?: () => boolean;
	messages?: {
		fetch?: (options: { limit: number }) => Promise<DiscordMessageCollectionLike>;
	};
};

type DiscordGuildLike = {
	channels?: { cache?: { values: () => Iterable<unknown> } };
};

type DiscordClientLike = {
	user?: DiscordUserLike | null;
	readyAt?: unknown;
	channels?: { fetch?: (id: string) => Promise<unknown> };
	guilds?: { cache?: { values: () => Iterable<DiscordGuildLike> } };
};

type DiscordServiceLike = {
	client?: DiscordClientLike | null;
	clientReadyPromise?: Promise<void> | null;
	messageManager?: { handleMessage?: (message: DiscordMessageLike) => Promise<void> };
	isChannelAllowed?: (channelId: string) => boolean;
};

type RuntimeWithServiceLookup = IAgentRuntime & {
	getService?: (type: string) => unknown;
	getServicesByType?: (type: string) => unknown[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function isDiscordService(value: unknown): value is DiscordServiceLike {
	const record = asRecord(value);
	if (!record) return false;
	const client = record.client;
	const manager = asRecord(record.messageManager);
	return (
		asRecord(client) !== null &&
		typeof manager?.handleMessage === "function"
	);
}

function resolveDiscordService(runtime: IAgentRuntime): DiscordServiceLike | null {
	const resolver = runtime as RuntimeWithServiceLookup;
	const direct = resolver.getService?.("discord");
	if (isDiscordService(direct)) return direct;
	const byType = resolver.getServicesByType?.("discord") ?? [];
	for (const candidate of byType) {
		if (isDiscordService(candidate)) return candidate;
	}
	return null;
}

function clampLimit(limit: number | undefined): number {
	if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
	return Math.max(1, Math.min(500, Math.trunc(limit ?? DEFAULT_LIMIT)));
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function aliasPattern(alias: string): RegExp {
	return new RegExp(`(^|[^\\p{L}\\p{N}_])@?${escapeRegex(alias)}(?=$|[^\\p{L}\\p{N}_])`, "iu");
}

function configuredAliases(runtime: IAgentRuntime, clientUser: DiscordUserLike | null | undefined): string[] {
	const raw = runtime.getSetting("DISCORD_MENTION_ALIASES");
	const configured = typeof raw === "string"
		? raw.split(/[\n,]+/).map((item) => item.trim()).filter((item) => item.length > 0)
		: [];
	return [
		...configured,
		runtime.character.name,
		runtime.character.username,
		clientUser?.username,
		clientUser?.globalName,
		clientUser?.tag,
		...DEFAULT_ALIASES,
	].filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function textMentionsAlias(text: string | undefined, aliases: string[]): boolean {
	if (!text) return false;
	return aliases.some((alias) => aliasPattern(alias.trim()).test(text));
}

function userCollectionHas(users: DiscordMentionUsersLike | undefined, id: string): boolean {
	return typeof users?.has === "function" && users.has(id);
}

function directlyAddressesBot(message: DiscordMessageLike, botId: string, aliases: string[]): boolean {
	const mentionsBot = userCollectionHas(message.mentions?.users, botId) ||
		message.content?.includes(`<@${botId}>`) === true ||
		message.content?.includes(`<@!${botId}>`) === true;
	const repliesToBot = message.reference?.messageId &&
		message.mentions?.repliedUser?.id === botId;
	return mentionsBot || repliesToBot === true || textMentionsAlias(message.content, aliases);
}

function hasBotReply(message: DiscordMessageLike, allMessages: DiscordMessageLike[], botId: string): boolean {
	const createdAt = message.createdTimestamp ?? 0;
	for (const candidate of allMessages) {
		if (candidate.author?.id !== botId) continue;
		if (candidate.reference?.messageId === message.id) return true;
		const replyAt = candidate.createdTimestamp ?? 0;
		if (createdAt > 0 && replyAt > createdAt && replyAt - createdAt <= BOT_REPLY_WINDOW_MS) return true;
	}
	return false;
}

function isTextChannel(value: unknown): value is DiscordTextChannelLike {
	const channel = asRecord(value);
	if (!channel || typeof channel.id !== "string") return false;
	const messages = asRecord(channel.messages);
	const textBased = typeof channel.isTextBased === "function" ? channel.isTextBased() : true;
	const voiceBased = typeof channel.isVoiceBased === "function" ? channel.isVoiceBased() : false;
	return textBased && !voiceBased && typeof messages?.fetch === "function";
}

async function resolveChannels(service: DiscordServiceLike, channelId?: string): Promise<DiscordTextChannelLike[]> {
	const client = service.client;
	if (!client) return [];
	if (channelId) {
		const cached = findCachedChannel(client, channelId);
		if (cached) return [cached];
		if (!client.channels?.fetch) return [];
		const fetched = await withTimeout(client.channels.fetch(channelId), FETCH_TIMEOUT_MS, `Discord channel fetch ${channelId}`);
		return isTextChannel(fetched) ? [fetched] : [];
	}
	const channels: DiscordTextChannelLike[] = [];
	for (const guild of client.guilds?.cache?.values() ?? []) {
		for (const candidate of guild.channels?.cache?.values() ?? []) {
			if (isTextChannel(candidate)) channels.push(candidate);
		}
	}
	return channels;
}

function findCachedChannel(client: DiscordClientLike, channelId: string): DiscordTextChannelLike | null {
	for (const guild of client.guilds?.cache?.values() ?? []) {
		for (const candidate of guild.channels?.cache?.values() ?? []) {
			if (isTextChannel(candidate) && candidate.id === channelId) return candidate;
		}
	}
	return null;
}

function emptyResult(): DiscordCatchUpResult {
	return {
		channelsScanned: 0,
		messagesScanned: 0,
		addressed: 0,
		alreadyAnswered: 0,
		replied: 0,
		errors: 0,
		errorDetails: [],
	};
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export async function runDiscordCatchUp(
	runtime: IAgentRuntime,
	options: DiscordCatchUpOptions = {},
): Promise<DiscordCatchUpResult> {
	const service = resolveDiscordService(runtime);
	if (!service?.client || typeof service.messageManager?.handleMessage !== "function") {
		throw new Error("Discord service not ready");
	}
	runtime.logger.info(
		{
			src: "detour:discord-catchup",
			channelId: options.channelId,
			limit: options.limit,
			maxAgeMs: options.maxAgeMs,
			hasReadyAt: Boolean(service.client.readyAt),
			hasBotUser: Boolean(service.client.user?.id),
		},
		"Discord catch-up requested",
	);
	if (!service.client.readyAt && !service.client.user?.id) {
		await service.clientReadyPromise?.catch((error) => {
			throw new Error(error instanceof Error ? error.message : String(error));
		});
	}

	const result = emptyResult();
	const limit = clampLimit(options.limit);
	const maxAgeMs = Number.isFinite(options.maxAgeMs) ? Math.max(0, options.maxAgeMs ?? DEFAULT_MAX_AGE_MS) : DEFAULT_MAX_AGE_MS;
	const oldestAllowed = maxAgeMs > 0 ? Date.now() - maxAgeMs : 0;
	const botId = service.client.user?.id;
	if (!botId) throw new Error("Discord bot user unavailable");
	const aliases = configuredAliases(runtime, service.client.user);
	const channels = await resolveChannels(service, options.channelId);

	runtime.logger.info(
		{
			src: "detour:discord-catchup",
			channelId: options.channelId,
			channelCount: channels.length,
			limit,
			maxAgeMs,
		},
		"Discord catch-up starting",
	);

	for (const channel of channels) {
		if (service.isChannelAllowed && !service.isChannelAllowed(channel.id)) continue;
		result.channelsScanned++;
		try {
			if (!channel.messages?.fetch) continue;
			const fetched = await withTimeout(channel.messages.fetch({ limit }), FETCH_TIMEOUT_MS, `Discord fetch ${channel.id}`);
			const messages = Array.from(fetched?.values() ?? [])
				.sort((a, b) => (a.createdTimestamp ?? 0) - (b.createdTimestamp ?? 0));
			result.messagesScanned += messages.length;
			for (const message of messages) {
				if (!message.id || message.interaction) continue;
				if (message.author?.bot || message.author?.id === botId) continue;
				if ((message.createdTimestamp ?? 0) < oldestAllowed) continue;
				if (!directlyAddressesBot(message, botId, aliases)) continue;
				result.addressed++;
				if (hasBotReply(message, messages, botId)) {
					result.alreadyAnswered++;
					continue;
				}
				await withTimeout(service.messageManager.handleMessage(message), HANDLE_TIMEOUT_MS, `Discord reply ${message.id}`);
				result.replied++;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			result.errors++;
			result.errorDetails.push({
				channelId: channel.id,
				...(channel.name ? { channelName: channel.name } : {}),
				error: message,
			});
			runtime.logger.warn(
				{
					src: "detour:discord-catchup",
					channelId: channel.id,
					channelName: channel.name,
					error: message,
				},
				"Discord catch-up failed for channel",
			);
		}
	}

	runtime.logger.info(
		{ src: "detour:discord-catchup", ...result },
		"Discord catch-up complete",
	);
	return result;
}
