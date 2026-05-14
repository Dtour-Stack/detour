/**
 * detour-telegram-media plugin — TELEGRAM_SEND_MEDIA action so the agent
 * can send generated images and videos to Telegram chats as native
 * attachments (photo / video / document) rather than just link previews.
 *
 * Mirrors X_POST and DISCORD_SEND_MEDIA's `mediaUrls` shape so the
 * planner has one consistent pattern to learn across channels.
 *
 *   { mediaUrls, text?, chatId?, threadId? }
 *
 * `chatId` defaults to the inbound message's room.channelId; for forum
 * topics pass `threadId` (Telegram's `message_thread_id`) so the post
 * lands in the right topic.
 *
 * Sends the FIRST URL as primary media with `text` as the caption, then
 * any additional URLs as a follow-up `sendMediaGroup`. This matches
 * Telegram's UX where a single attachment + caption renders inline and
 * groups appear as an album.
 */

import {
	type Action,
	type ActionResult,
	type HandlerCallback,
	type HandlerOptions,
	type IAgentRuntime,
	type Memory,
	logger,
	type Plugin,
	type State,
} from "@elizaos/core";

const TELEGRAM_SERVICE_NAME = "telegram";
const MAX_URLS = 10;

interface TelegrafLike {
	telegram: {
		sendPhoto: (chatId: string | number, source: string | { source: Buffer }, extra?: Record<string, unknown>) => Promise<{ message_id: number }>;
		sendVideo: (chatId: string | number, source: string | { source: Buffer }, extra?: Record<string, unknown>) => Promise<{ message_id: number }>;
		sendDocument: (chatId: string | number, source: string | { source: Buffer }, extra?: Record<string, unknown>) => Promise<{ message_id: number }>;
		sendAnimation: (chatId: string | number, source: string | { source: Buffer }, extra?: Record<string, unknown>) => Promise<{ message_id: number }>;
		sendAudio: (chatId: string | number, source: string | { source: Buffer }, extra?: Record<string, unknown>) => Promise<{ message_id: number }>;
		sendMediaGroup: (
			chatId: string | number,
			media: Array<{ type: string; media: string | { source: Buffer }; caption?: string }>,
			extra?: Record<string, unknown>,
		) => Promise<Array<{ message_id: number }>>;
	};
}

interface TelegramServiceLike {
	bot: TelegrafLike | null;
}

type MediaKind = "photo" | "video" | "animation" | "audio" | "document";

function mediaKindForMime(mime: string | null | undefined): MediaKind {
	const m = (mime ?? "").toLowerCase();
	if (m === "image/gif") return "animation";
	if (m.startsWith("image/")) return "photo";
	if (m.startsWith("video/")) return "video";
	if (m.startsWith("audio/")) return "audio";
	return "document";
}

function pickString(opts: Record<string, unknown> | undefined, keys: string[]): string | undefined {
	if (!opts) return undefined;
	for (const k of keys) {
		const v = opts[k];
		if (typeof v === "string" && v.trim().length > 0) return v.trim();
	}
	return undefined;
}

function pickMediaUrls(opts: Record<string, unknown> | undefined): string[] {
	if (!opts) return [];
	const out: string[] = [];
	for (const key of ["mediaUrls", "mediaUrl", "imageUrl", "imageUrls", "videoUrl", "videoUrls", "files"]) {
		const value = opts[key];
		if (typeof value === "string") {
			out.push(...value.split(/[,\s]+/).filter((v) => v.startsWith("http")));
		} else if (Array.isArray(value)) {
			for (const v of value) {
				if (typeof v === "string" && v.startsWith("http")) out.push(v);
			}
		}
	}
	return Array.from(new Set(out)).slice(0, MAX_URLS);
}

function extensionGuess(url: string): { kind: MediaKind; mime: string | null } {
	const lower = url.split("?")[0]?.toLowerCase() ?? "";
	if (lower.endsWith(".gif")) return { kind: "animation", mime: "image/gif" };
	if (/\.(png|jpe?g|webp)$/i.test(lower)) return { kind: "photo", mime: "image/jpeg" };
	if (/\.(mp4|mov|webm)$/i.test(lower)) return { kind: "video", mime: "video/mp4" };
	if (/\.(mp3|wav|ogg|m4a)$/i.test(lower)) return { kind: "audio", mime: "audio/mpeg" };
	return { kind: "document", mime: null };
}

async function classifyUrl(url: string): Promise<{ kind: MediaKind; mime: string | null }> {
	try {
		const head = await fetch(url, { method: "HEAD" });
		if (!head.ok) return extensionGuess(url);
		const ct = head.headers.get("content-type");
		if (!ct) return extensionGuess(url);
		return { kind: mediaKindForMime(ct), mime: ct };
	} catch {
		return extensionGuess(url);
	}
}

async function resolveChannel(
	runtime: IAgentRuntime,
	message: Memory,
	explicitChatId: string | undefined,
	explicitThreadId: string | undefined,
): Promise<{ chatId: string; threadId?: number } | null> {
	let chatId = explicitChatId;
	let threadId = explicitThreadId ? Number.parseInt(explicitThreadId, 10) : undefined;
	if (!chatId) {
		const room = await (runtime as unknown as {
			getRoom: (id: string) => Promise<{ channelId?: string } | null>;
		}).getRoom(message.roomId);
		// Telegram channels are stored as `<chatId>` or `<chatId>:<threadId>`.
		const ch = room?.channelId;
		if (!ch) return null;
		const [c, t] = ch.split(":");
		if (!c) return null;
		chatId = c;
		if (threadId === undefined && t) threadId = Number.parseInt(t, 10);
	}
	if (Number.isNaN(threadId)) threadId = undefined;
	return threadId !== undefined ? { chatId, threadId } : { chatId };
}

const handler: Action["handler"] = async (
	runtime: IAgentRuntime,
	message: Memory,
	_state?: State,
	options?: HandlerOptions,
	callback?: HandlerCallback,
): Promise<ActionResult> => {
	const opts = options?.parameters as Record<string, unknown> | undefined;
	const text = pickString(opts, ["text", "caption", "content", "message"]);
	const mediaUrls = pickMediaUrls(opts);
	const explicitChatId = pickString(opts, ["chatId", "channelId", "channel"]);
	const explicitThreadId = pickString(opts, ["threadId", "messageThreadId"]);

	if (mediaUrls.length === 0) {
		await callback?.({
			text: "TELEGRAM_SEND_MEDIA requires at least one mediaUrls entry.",
			source: "telegram",
		});
		return { success: false, error: "no media urls" };
	}

	const service = runtime.getService(TELEGRAM_SERVICE_NAME) as unknown as TelegramServiceLike | undefined;
	if (!service?.bot) {
		await callback?.({ text: "Telegram service is not available.", source: "telegram" });
		return { success: false, error: "TELEGRAM_SERVICE_UNAVAILABLE" };
	}

	const channel = await resolveChannel(runtime, message, explicitChatId, explicitThreadId);
	if (!channel) {
		await callback?.({
			text: "Could not determine the Telegram chat to send to. Pass `chatId` or send from a chat-routed message.",
			source: "telegram",
		});
		return { success: false, error: "no chat" };
	}

	// Classify every URL up front; collect successes for sending.
	const classified: Array<{ url: string; kind: MediaKind; mime: string | null }> = [];
	const errors: string[] = [];
	for (const url of mediaUrls) {
		try {
			classified.push({ url, ...(await classifyUrl(url)) });
		} catch (err) {
			errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	if (classified.length === 0) {
		await callback?.({
			text: `All ${mediaUrls.length} URLs failed to classify. Last error: ${errors[errors.length - 1] ?? "unknown"}`,
			source: "telegram",
		});
		return { success: false, error: "all classify failed", data: { errors } };
	}

	const baseExtra: Record<string, unknown> = {};
	if (channel.threadId !== undefined) baseExtra.message_thread_id = channel.threadId;

	const sentIds: number[] = [];
	try {
		const [first, ...rest] = classified;
		const firstExtra = { ...baseExtra, ...(text ? { caption: text } : {}) };
		const sender = pickSender(service.bot, first.kind);
		const firstSent = await sender(channel.chatId, first.url, firstExtra);
		sentIds.push(firstSent.message_id);

		if (rest.length > 0) {
			// Telegram caps groups at 10 items including the first; we've already
			// capped pickMediaUrls at MAX_URLS.
			const groupItems = rest.map((c) => ({
				type: c.kind === "photo" ? "photo" : c.kind === "video" ? "video" : "document",
				media: c.url,
			}));
			const groupResult = await service.bot.telegram.sendMediaGroup(channel.chatId, groupItems, baseExtra);
			for (const r of groupResult) sentIds.push(r.message_id);
		}

		logger.info(
			{ src: "detour-telegram-media", chatId: channel.chatId, threadId: channel.threadId, count: sentIds.length },
			"TELEGRAM_SEND_MEDIA sent",
		);
		await callback?.({
			text: `Sent to Telegram (${sentIds.length} attachment${sentIds.length === 1 ? "" : "s"}).`,
			source: "telegram",
		});
		return {
			success: true,
			data: {
				chatId: channel.chatId,
				threadId: channel.threadId,
				messageIds: sentIds,
				...(errors.length > 0 ? { warnings: errors } : {}),
			},
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error({ src: "detour-telegram-media", chatId: channel.chatId, err: msg }, "send failed");
		await callback?.({ text: `Telegram send failed: ${msg}`, source: "telegram" });
		return { success: false, error: msg };
	}
};

function pickSender(
	bot: TelegrafLike,
	kind: MediaKind,
): (chatId: string | number, source: string | { source: Buffer }, extra?: Record<string, unknown>) => Promise<{ message_id: number }> {
	switch (kind) {
		case "photo": return bot.telegram.sendPhoto.bind(bot.telegram);
		case "video": return bot.telegram.sendVideo.bind(bot.telegram);
		case "animation": return bot.telegram.sendAnimation.bind(bot.telegram);
		case "audio": return bot.telegram.sendAudio.bind(bot.telegram);
		default: return bot.telegram.sendDocument.bind(bot.telegram);
	}
}

export const telegramSendMediaAction: Action = {
	name: "TELEGRAM_SEND_MEDIA",
	similes: [
		"SEND_TELEGRAM_PHOTO",
		"SEND_TELEGRAM_VIDEO",
		"TELEGRAM_ATTACH_MEDIA",
		"POST_MEDIA_TELEGRAM",
	],
	description:
		"Send an image, video, animation (gif), audio, or document to a Telegram chat as a native attachment. Pass `mediaUrls` (or `imageUrl`/`videoUrl`) — typically the hosted URL from GENERATE_IMAGE / GENERATE_VIDEO / ELEVENLABS_* — plus optional `text` (becomes the first attachment's caption). Channel defaults to the inbound message's chat; override with `chatId` and optional `threadId` (for forum topics). First URL is sent as the primary attachment; additional URLs ship as a sendMediaGroup album (up to 10 total).",
	descriptionCompressed:
		"send media (photo/video/animation/audio/doc) to Telegram as a native attachment.",
	validate: async (runtime: IAgentRuntime): Promise<boolean> => {
		const svc = runtime.getService(TELEGRAM_SERVICE_NAME) as unknown as TelegramServiceLike | undefined;
		return Boolean(svc?.bot);
	},
	handler,
	examples: [],
	parameters: [
		{
			name: "mediaUrls",
			description: "Hosted media URLs to attach (typically from GENERATE_IMAGE / GENERATE_VIDEO / ELEVENLABS_*). Up to 10 per message.",
			required: true,
			schema: { type: "array" as const, items: { type: "string" as const } },
		},
		{
			name: "text",
			description: "Optional caption shown on the first attachment.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "chatId",
			description: "Optional explicit Telegram chat id. Defaults to the inbound message's chat.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "threadId",
			description: "Optional Telegram forum topic id (message_thread_id) — required for forum-topic chats.",
			required: false,
			schema: { type: "string" as const },
		},
	],
};

export const detourTelegramMediaPlugin: Plugin = {
	name: "detour-telegram-media",
	description:
		"Adds TELEGRAM_SEND_MEDIA so the agent can send generated images/videos/audio to Telegram as native attachments — closes the gap where the stock telegram plugin has no media-send action.",
	actions: [telegramSendMediaAction],
};

export { mediaKindForMime };
