/**
 * detour-discord-media plugin — closes the gap where Discord's stock
 * `SEND_MESSAGE` action only accepts text. Detour generates images and
 * videos via GENERATE_IMAGE / GENERATE_VIDEO; without this plugin those
 * hosted URLs can only ride as link previews, not as native attachments.
 *
 * Provides DISCORD_SEND_MEDIA:
 *   { channelId?: string, text?: string, mediaUrls: string[] }
 *
 * Resolves each URL to bytes, attaches them via discord.js's
 * `TextChannel.send({ content, files })`. Channel defaults to the
 * inbound message's roomId-derived channel when channelId is omitted.
 *
 * Caps at 10 attachments per message (Discord's hard limit). Failed
 * uploads are logged and dropped — partial attach still ships, matching
 * the "always attempt" execution-contract rule.
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

const DISCORD_SERVICE_NAME = "discord";
const MAX_ATTACHMENTS = 10;

interface DiscordChannelLike {
	send: (options: { content?: string; files?: Array<{ attachment: Buffer; name: string }> }) => Promise<{ id: string; url?: string }>;
	isTextBased?: () => boolean;
}

interface DiscordClientLike {
	channels: { fetch: (id: string) => Promise<unknown> };
}

interface DiscordServiceLike {
	client: DiscordClientLike | null;
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
	return Array.from(new Set(out)).slice(0, MAX_ATTACHMENTS);
}

function filenameFromUrl(url: string, mime: string | null): string {
	try {
		const u = new URL(url);
		const tail = u.pathname.split("/").pop() ?? "";
		if (tail && tail.includes(".")) return tail.slice(0, 80);
	} catch {
		/* fall through */
	}
	const ext = mime?.split("/")[1]?.split(";")[0]?.trim() ?? "bin";
	return `detour-media.${ext}`;
}

async function downloadEach(urls: string[]): Promise<{
	files: Array<{ attachment: Buffer; name: string }>;
	errors: string[];
}> {
	const files: Array<{ attachment: Buffer; name: string }> = [];
	const errors: string[] = [];
	for (const url of urls) {
		try {
			const res = await fetch(url);
			if (!res.ok) {
				errors.push(`${url}: HTTP ${res.status}`);
				continue;
			}
			const ct = res.headers.get("content-type");
			const bytes = Buffer.from(await res.arrayBuffer());
			files.push({ attachment: bytes, name: filenameFromUrl(url, ct) });
		} catch (err) {
			errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return { files, errors };
}

async function resolveChannelId(
	runtime: IAgentRuntime,
	message: Memory,
	explicit: string | undefined,
): Promise<string | null> {
	if (explicit) return explicit;
	const room = await (runtime as unknown as {
		getRoom: (id: string) => Promise<{ channelId?: string } | null>;
	}).getRoom(message.roomId);
	return room?.channelId ?? null;
}

const handler: Action["handler"] = async (
	runtime: IAgentRuntime,
	message: Memory,
	_state?: State,
	options?: HandlerOptions,
	callback?: HandlerCallback,
): Promise<ActionResult> => {
	const opts = options?.parameters as Record<string, unknown> | undefined;
	const text = pickString(opts, ["text", "content", "body", "message"]);
	const mediaUrls = pickMediaUrls(opts);
	const explicitChannelId = pickString(opts, ["channelId", "channel", "channelRef"]);

	if (mediaUrls.length === 0) {
		await callback?.({
			text: "DISCORD_SEND_MEDIA requires at least one `mediaUrls` entry (otherwise use SEND_MESSAGE for plain text).",
			source: "discord",
		});
		return { success: false, error: "no media urls" };
	}

	const service = runtime.getService(DISCORD_SERVICE_NAME) as unknown as DiscordServiceLike | undefined;
	if (!service?.client) {
		await callback?.({
			text: "Discord service is not available.",
			source: "discord",
		});
		return { success: false, error: "DISCORD_SERVICE_UNAVAILABLE" };
	}

	const channelId = await resolveChannelId(runtime, message, explicitChannelId);
	if (!channelId) {
		await callback?.({
			text: "Could not determine the Discord channel to send to. Pass `channelId` or send from a channel-routed message.",
			source: "discord",
		});
		return { success: false, error: "no channel" };
	}

	const channel = (await service.client.channels.fetch(channelId)) as DiscordChannelLike | null;
	if (!channel || typeof channel.send !== "function") {
		await callback?.({
			text: `Channel ${channelId} not found or not a text channel.`,
			source: "discord",
		});
		return { success: false, error: "bad channel" };
	}
	if (channel.isTextBased && !channel.isTextBased()) {
		await callback?.({
			text: `Channel ${channelId} is not text-based; cannot send media there.`,
			source: "discord",
		});
		return { success: false, error: "not text channel" };
	}

	const { files, errors } = await downloadEach(mediaUrls);
	if (errors.length > 0) {
		logger.warn(
			{ src: "detour-discord-media", channelId, errors },
			"some media downloads failed; sending with what attached",
		);
	}
	if (files.length === 0) {
		await callback?.({
			text: `All ${mediaUrls.length} media URL(s) failed to download. Last error: ${errors[errors.length - 1] ?? "unknown"}`,
			source: "discord",
		});
		return { success: false, error: "all downloads failed", data: { errors } };
	}

	try {
		const sent = await channel.send({
			...(text ? { content: text } : {}),
			files,
		});
		logger.info(
			{ src: "detour-discord-media", channelId, messageId: sent.id, count: files.length },
			"DISCORD_SEND_MEDIA sent",
		);
		await callback?.({
			text: `Sent to Discord (${files.length} attachment${files.length === 1 ? "" : "s"}).`,
			source: "discord",
		});
		return {
			success: true,
			data: {
				messageId: sent.id,
				channelId,
				attachmentCount: files.length,
				...(errors.length > 0 ? { warnings: errors } : {}),
			},
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error({ src: "detour-discord-media", channelId, err: msg }, "send failed");
		await callback?.({ text: `Discord send failed: ${msg}`, source: "discord" });
		return { success: false, error: msg };
	}
};

export const discordSendMediaAction: Action = {
	name: "DISCORD_SEND_MEDIA",
	similes: [
		"SEND_DISCORD_IMAGE",
		"SEND_DISCORD_VIDEO",
		"DISCORD_ATTACH_MEDIA",
		"POST_MEDIA_DISCORD",
	],
	description:
		"Send an image or video (or both, up to 10) to a Discord channel as a native attachment. Pass `mediaUrls` (or `imageUrl`/`videoUrl`) — typically the hosted URL returned by GENERATE_IMAGE / GENERATE_VIDEO — and optional `text` to use as the message body. Channel defaults to the inbound message's channel; override with `channelId`. Discord plugin's stock SEND_MESSAGE is text-only — use this action whenever you have media to attach.",
	descriptionCompressed:
		"send images/videos to Discord as real attachments (not just links).",
	validate: async (runtime: IAgentRuntime): Promise<boolean> => {
		const svc = runtime.getService(DISCORD_SERVICE_NAME) as unknown as DiscordServiceLike | undefined;
		return Boolean(svc?.client);
	},
	handler,
	examples: [],
	parameters: [
		{
			name: "mediaUrls",
			description: "Hosted media URLs to attach (typically from GENERATE_IMAGE / GENERATE_VIDEO). Up to 10 per message.",
			required: true,
			schema: { type: "array" as const, items: { type: "string" as const } },
		},
		{
			name: "text",
			description: "Optional text body shown alongside the attachment(s).",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "channelId",
			description: "Optional explicit Discord channel id. Defaults to the inbound message's channel.",
			required: false,
			schema: { type: "string" as const },
		},
	],
};

export const detourDiscordMediaPlugin: Plugin = {
	name: "detour-discord-media",
	description:
		"Adds DISCORD_SEND_MEDIA so the agent can send generated images/videos to Discord as native attachments. Closes the gap where stock SEND_MESSAGE is text-only.",
	actions: [discordSendMediaAction],
};
