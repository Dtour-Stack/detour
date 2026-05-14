/**
 * detour-imessage-media plugin — IMESSAGE_SEND_MEDIA action.
 *
 * Eliza's stock `IMESSAGE_SEND_MESSAGE` action sends text only; the
 * service-level `sendMessage(to, text, { mediaUrl })` does accept a media
 * pointer but expects a LOCAL file path (Messages.app's AppleScript
 * bridge wants `POSIX file <path>` — it can't fetch an HTTP URL).
 *
 * This plugin closes the loop: download each HTTP URL to a temp file
 * under `userCache/imessage-attachments/`, hand the local paths to the
 * service, clean up after the send completes (success or failure).
 *
 * Each `mediaUrl` is sent as a separate attachment (Messages.app's
 * AppleScript bridge ships one file per `send` verb; we serialize the
 * sends so the conversation thread receives them in order).
 *
 *   { mediaUrls, text?, to? }
 *
 * `to` is a phone number, email, or `chat_id:<guid>`. Falls back to the
 * inbound message's roomId-derived handle when omitted.
 */

import { randomBytes } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
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

const IMESSAGE_SERVICE_NAME = "imessage";
const MAX_URLS = 10;

interface IMessageServiceLike {
	isConnected?: () => boolean;
	isMacOS?: () => boolean;
	sendMessage: (
		to: string,
		text: string,
		options?: { mediaUrl?: string },
	) => Promise<{ success: boolean; error?: string; messageId?: string }>;
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

/**
 * Pick a sensible file extension. Prefer the URL's existing extension,
 * fall back to the response MIME type, default to `.bin`. Messages.app
 * uses the extension to decide the inline preview (image vs file).
 */
function extensionFor(url: string, mime: string | null): string {
	try {
		const u = new URL(url);
		const ext = extname(u.pathname);
		if (ext && ext.length <= 6) return ext;
	} catch {
		/* fall through */
	}
	if (mime) {
		const sub = mime.split("/")[1]?.split(";")[0]?.trim();
		if (sub) return `.${sub === "jpeg" ? "jpg" : sub}`;
	}
	return ".bin";
}

async function downloadToTemp(url: string): Promise<{ path: string; cleanup: () => Promise<void> } | { error: string }> {
	try {
		const res = await fetch(url);
		if (!res.ok) return { error: `HTTP ${res.status}` };
		const ct = res.headers.get("content-type");
		const bytes = new Uint8Array(await res.arrayBuffer());
		const dir = join(tmpdir(), "detour-imessage-attachments");
		await mkdir(dir, { recursive: true });
		const filename = `${Date.now()}-${randomBytes(4).toString("hex")}${extensionFor(url, ct)}`;
		const path = join(dir, filename);
		await writeFile(path, bytes);
		return {
			path,
			cleanup: async () => {
				try {
					await unlink(path);
				} catch {
					/* best-effort */
				}
			},
		};
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

async function resolveTarget(
	runtime: IAgentRuntime,
	message: Memory,
	explicit: string | undefined,
): Promise<string | null> {
	if (explicit) return explicit;
	try {
		const room = await (runtime as unknown as {
			getRoom: (id: string) => Promise<{ channelId?: string } | null>;
		}).getRoom(message.roomId);
		if (room?.channelId) return room.channelId;
	} catch {
		/* fall through */
	}
	return null;
}

const handler: Action["handler"] = async (
	runtime: IAgentRuntime,
	message: Memory,
	_state?: State,
	options?: HandlerOptions,
	callback?: HandlerCallback,
): Promise<ActionResult> => {
	const opts = options?.parameters as Record<string, unknown> | undefined;
	const text = pickString(opts, ["text", "content", "body", "message"]) ?? "";
	const mediaUrls = pickMediaUrls(opts);
	const explicitTo = pickString(opts, ["to", "recipient", "phoneNumber", "email", "chatId"]);

	if (mediaUrls.length === 0) {
		await callback?.({
			text: "IMESSAGE_SEND_MEDIA requires at least one mediaUrls entry. Use IMESSAGE_SEND_MESSAGE for plain text.",
			source: "imessage",
		});
		return { success: false, error: "no media urls" };
	}

	const service = runtime.getService(IMESSAGE_SERVICE_NAME) as unknown as IMessageServiceLike | undefined;
	if (!service?.sendMessage) {
		await callback?.({ text: "iMessage service is not available.", source: "imessage" });
		return { success: false, error: "IMESSAGE_SERVICE_UNAVAILABLE" };
	}
	if (service.isConnected && !service.isConnected()) {
		await callback?.({ text: "iMessage service is not connected.", source: "imessage" });
		return { success: false, error: "IMESSAGE_NOT_CONNECTED" };
	}
	if (service.isMacOS && !service.isMacOS()) {
		await callback?.({ text: "iMessage is only available on macOS.", source: "imessage" });
		return { success: false, error: "IMESSAGE_NEEDS_MACOS" };
	}

	const target = await resolveTarget(runtime, message, explicitTo);
	if (!target) {
		await callback?.({
			text: "Could not determine the iMessage recipient. Pass `to` with a phone number, email, or chat_id:<guid>.",
			source: "imessage",
		});
		return { success: false, error: "no recipient" };
	}

	// Download all URLs to temp files first; collect cleanup callbacks.
	const downloads: Array<{ path: string; cleanup: () => Promise<void> }> = [];
	const downloadErrors: string[] = [];
	for (const url of mediaUrls) {
		const result = await downloadToTemp(url);
		if ("error" in result) {
			downloadErrors.push(`${url}: ${result.error}`);
		} else {
			downloads.push(result);
		}
	}

	if (downloads.length === 0) {
		await callback?.({
			text: `All ${mediaUrls.length} media URLs failed to download. Last error: ${downloadErrors[downloadErrors.length - 1] ?? "unknown"}`,
			source: "imessage",
		});
		return { success: false, error: "all downloads failed", data: { errors: downloadErrors } };
	}

	const sendErrors: string[] = [];
	let sentCount = 0;
	try {
		// First send: include the text body (if any) alongside the first
		// attachment. Subsequent sends are attachment-only — the AppleScript
		// bridge ships one file per `send` verb, so we serialize.
		const [first, ...rest] = downloads;
		const firstResult = await service.sendMessage(target, text, { mediaUrl: first.path });
		if (!firstResult.success) {
			sendErrors.push(firstResult.error ?? "first send failed");
		} else {
			sentCount++;
		}
		for (const dl of rest) {
			const r = await service.sendMessage(target, "", { mediaUrl: dl.path });
			if (!r.success) sendErrors.push(r.error ?? "send failed");
			else sentCount++;
		}
	} finally {
		// Always clean up temp files, even if sends failed mid-way.
		await Promise.all(downloads.map((d) => d.cleanup()));
	}

	if (sentCount === 0) {
		await callback?.({
			text: `iMessage send failed for all attachments. Errors: ${sendErrors.join("; ")}`,
			source: "imessage",
		});
		return { success: false, error: "all sends failed", data: { errors: sendErrors } };
	}

	logger.info(
		{ src: "detour-imessage-media", target, sentCount, total: mediaUrls.length },
		"IMESSAGE_SEND_MEDIA sent",
	);
	await callback?.({
		text: `Sent to iMessage (${sentCount} attachment${sentCount === 1 ? "" : "s"}).`,
		source: "imessage",
	});

	const warnings = [...downloadErrors, ...sendErrors];
	return {
		success: true,
		data: {
			to: target,
			sentCount,
			...(warnings.length > 0 ? { warnings } : {}),
		},
	};
};

export const imessageSendMediaAction: Action = {
	name: "IMESSAGE_SEND_MEDIA",
	similes: [
		"SEND_IMESSAGE_PHOTO",
		"SEND_IMESSAGE_VIDEO",
		"IMESSAGE_ATTACH_MEDIA",
		"TEXT_MEDIA",
	],
	description:
		"Send an image, video, or any file via iMessage (macOS only) as a native attachment. Pass `mediaUrls` (or `imageUrl`/`videoUrl`) — typically hosted URLs from GENERATE_IMAGE / GENERATE_VIDEO — plus optional `text` (used as the body of the first message). Each URL is downloaded to a temp file then handed to Messages.app via AppleScript. `to` accepts a phone number, email, or `chat_id:<guid>`; defaults to the inbound message's iMessage handle. Multiple URLs ship as separate sends (Messages.app's bridge is one-file-per-send).",
	descriptionCompressed:
		"send images/videos/files to iMessage as native attachments (macOS).",
	validate: async (runtime: IAgentRuntime): Promise<boolean> => {
		const svc = runtime.getService(IMESSAGE_SERVICE_NAME) as unknown as IMessageServiceLike | undefined;
		if (!svc?.sendMessage) return false;
		if (svc.isConnected && !svc.isConnected()) return false;
		if (svc.isMacOS && !svc.isMacOS()) return false;
		return true;
	},
	handler,
	examples: [],
	parameters: [
		{
			name: "mediaUrls",
			description: "Hosted media URLs to attach. Downloaded to temp files then sent via Messages.app's AppleScript bridge. Up to 10.",
			required: true,
			schema: { type: "array" as const, items: { type: "string" as const } },
		},
		{
			name: "text",
			description: "Optional message body — included with the first attachment.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "to",
			description: "Optional recipient: phone number, email, or chat_id:<guid>. Defaults to the inbound message's iMessage handle.",
			required: false,
			schema: { type: "string" as const },
		},
	],
};

export const detourIMessageMediaPlugin: Plugin = {
	name: "detour-imessage-media",
	description:
		"Adds IMESSAGE_SEND_MEDIA so the agent can send generated images/videos to iMessage as native attachments — downloads URLs to temp files then hands paths to Messages.app via AppleScript.",
	actions: [imessageSendMediaAction],
};

export { downloadToTemp, extensionFor };
