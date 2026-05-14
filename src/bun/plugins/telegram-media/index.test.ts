import { describe, expect, test, afterEach } from "bun:test";
import type { HandlerCallback, IAgentRuntime, Memory } from "@elizaos/core";
import { detourTelegramMediaPlugin, mediaKindForMime, telegramSendMediaAction } from "./index";

const FETCH = globalThis.fetch;

function installFetch(map: Record<string, { status: number; contentType?: string }>): void {
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const hit = map[url];
		if (!hit) return new Response("not found", { status: 404 });
		const headers: Record<string, string> = {};
		if (hit.contentType) headers["content-type"] = hit.contentType;
		// HEAD requests skip body
		if (init?.method === "HEAD") return new Response(null, { status: hit.status, headers });
		return new Response(new Blob([]), { status: hit.status, headers });
	}) as typeof fetch;
}

interface SentPrimary {
	kind: string;
	chatId: string | number;
	url: string | { source: Buffer };
	extra?: Record<string, unknown>;
}

function makeRuntimeAndBot() {
	const sentPrimary: SentPrimary[] = [];
	const sentGroups: Array<{ chatId: string | number; items: Array<{ type: string; media: string }>; extra?: Record<string, unknown> }> = [];
	let nextId = 100;
	const make = (kind: string) => async (chatId: string | number, url: string | { source: Buffer }, extra?: Record<string, unknown>) => {
		sentPrimary.push({ kind, chatId, url, extra });
		return { message_id: nextId++ };
	};
	const bot = {
		telegram: {
			sendPhoto: make("photo"),
			sendVideo: make("video"),
			sendDocument: make("document"),
			sendAudio: make("audio"),
			sendAnimation: make("animation"),
			sendMediaGroup: async (chatId: string | number, media: Array<{ type: string; media: string }>, extra?: Record<string, unknown>) => {
				sentGroups.push({ chatId, items: media, extra });
				return media.map(() => ({ message_id: nextId++ }));
			},
		},
	};
	const runtime = {
		getService: (name: string) => (name === "telegram" ? { bot } : undefined),
		getRoom: async () => ({ channelId: "9001" }),
	};
	return { runtime: runtime as unknown as IAgentRuntime, sentPrimary, sentGroups };
}

function makeMessage(): Memory {
	return {
		id: "m-1",
		entityId: "e-1",
		roomId: "r-1",
		content: { source: "telegram" },
	} as unknown as Memory;
}

afterEach(() => {
	globalThis.fetch = FETCH;
});

describe("mediaKindForMime", () => {
	test("image/png → photo", () => {
		expect(mediaKindForMime("image/png")).toBe("photo");
	});
	test("image/gif → animation", () => {
		expect(mediaKindForMime("image/gif")).toBe("animation");
	});
	test("video/mp4 → video", () => {
		expect(mediaKindForMime("video/mp4")).toBe("video");
	});
	test("audio/mpeg → audio", () => {
		expect(mediaKindForMime("audio/mpeg")).toBe("audio");
	});
	test("unknown → document", () => {
		expect(mediaKindForMime("application/pdf")).toBe("document");
		expect(mediaKindForMime(null)).toBe("document");
	});
});

describe("TELEGRAM_SEND_MEDIA action", () => {
	test("plugin exposes only TELEGRAM_SEND_MEDIA", () => {
		expect(detourTelegramMediaPlugin.actions?.map((a) => a.name)).toEqual(["TELEGRAM_SEND_MEDIA"]);
	});

	test("validate is false without telegram service", async () => {
		const runtime = { getService: () => undefined } as unknown as IAgentRuntime;
		expect(await telegramSendMediaAction.validate(runtime, {} as Memory)).toBe(false);
	});

	test("validate is true with telegram bot", async () => {
		const runtime = { getService: () => ({ bot: {} }) } as unknown as IAgentRuntime;
		expect(await telegramSendMediaAction.validate(runtime, {} as Memory)).toBe(true);
	});

	test("sends a single photo with caption", async () => {
		installFetch({ "https://x.test/cat.png": { status: 200, contentType: "image/png" } });
		const { runtime, sentPrimary, sentGroups } = makeRuntimeAndBot();
		const cbCalls: string[] = [];
		const cb: HandlerCallback = async (p) => { if (typeof p.text === "string") cbCalls.push(p.text); return []; };
		const result = await telegramSendMediaAction.handler(
			runtime,
			makeMessage(),
			undefined,
			{ parameters: { mediaUrls: ["https://x.test/cat.png"], text: "look" } },
			cb,
		);
		expect(result?.success).toBe(true);
		expect(sentPrimary).toHaveLength(1);
		expect(sentPrimary[0]?.kind).toBe("photo");
		expect(sentPrimary[0]?.chatId).toBe("9001");
		expect(sentPrimary[0]?.extra?.caption).toBe("look");
		expect(sentGroups).toHaveLength(0);
	});

	test("routes video MIME to sendVideo", async () => {
		installFetch({ "https://x.test/clip.mp4": { status: 200, contentType: "video/mp4" } });
		const { runtime, sentPrimary } = makeRuntimeAndBot();
		const result = await telegramSendMediaAction.handler(
			runtime,
			makeMessage(),
			undefined,
			{ parameters: { mediaUrls: ["https://x.test/clip.mp4"] } },
		);
		expect(result?.success).toBe(true);
		expect(sentPrimary[0]?.kind).toBe("video");
	});

	test("routes gif MIME to sendAnimation", async () => {
		installFetch({ "https://x.test/loop.gif": { status: 200, contentType: "image/gif" } });
		const { runtime, sentPrimary } = makeRuntimeAndBot();
		const result = await telegramSendMediaAction.handler(
			runtime,
			makeMessage(),
			undefined,
			{ parameters: { mediaUrls: ["https://x.test/loop.gif"] } },
		);
		expect(result?.success).toBe(true);
		expect(sentPrimary[0]?.kind).toBe("animation");
	});

	test("multiple URLs: first as primary, rest as sendMediaGroup", async () => {
		installFetch({
			"https://x.test/a.png": { status: 200, contentType: "image/png" },
			"https://x.test/b.png": { status: 200, contentType: "image/png" },
			"https://x.test/c.png": { status: 200, contentType: "image/png" },
		});
		const { runtime, sentPrimary, sentGroups } = makeRuntimeAndBot();
		const result = await telegramSendMediaAction.handler(
			runtime,
			makeMessage(),
			undefined,
			{ parameters: { mediaUrls: ["https://x.test/a.png", "https://x.test/b.png", "https://x.test/c.png"] } },
		);
		expect(result?.success).toBe(true);
		expect(sentPrimary).toHaveLength(1);
		expect(sentGroups).toHaveLength(1);
		expect(sentGroups[0]?.items).toHaveLength(2);
	});

	test("threadId is passed through as message_thread_id", async () => {
		installFetch({ "https://x.test/a.png": { status: 200, contentType: "image/png" } });
		const { runtime, sentPrimary } = makeRuntimeAndBot();
		const result = await telegramSendMediaAction.handler(
			runtime,
			makeMessage(),
			undefined,
			{ parameters: { mediaUrls: ["https://x.test/a.png"], threadId: "42" } },
		);
		expect(result?.success).toBe(true);
		expect(sentPrimary[0]?.extra?.message_thread_id).toBe(42);
	});

	test("falls back to URL extension when HEAD fails", async () => {
		installFetch({}); // no HEAD response → fall through to extension guess
		const { runtime, sentPrimary } = makeRuntimeAndBot();
		const result = await telegramSendMediaAction.handler(
			runtime,
			makeMessage(),
			undefined,
			{ parameters: { mediaUrls: ["https://x.test/song.mp3"] } },
		);
		expect(result?.success).toBe(true);
		expect(sentPrimary[0]?.kind).toBe("audio");
	});

	test("rejects when no media URLs supplied", async () => {
		const { runtime, sentPrimary } = makeRuntimeAndBot();
		const result = await telegramSendMediaAction.handler(
			runtime,
			makeMessage(),
			undefined,
			{ parameters: { text: "no media" } },
		);
		expect(result?.success).toBe(false);
		expect(sentPrimary).toHaveLength(0);
	});

	test("fails cleanly when service missing", async () => {
		installFetch({ "https://x.test/a.png": { status: 200, contentType: "image/png" } });
		const runtime = { getService: () => undefined, getRoom: async () => ({ channelId: "9001" }) } as unknown as IAgentRuntime;
		const result = await telegramSendMediaAction.handler(
			runtime,
			makeMessage(),
			undefined,
			{ parameters: { mediaUrls: ["https://x.test/a.png"] } },
		);
		expect(result?.success).toBe(false);
		expect(result?.error).toBe("TELEGRAM_SERVICE_UNAVAILABLE");
	});

	test("explicit chatId overrides room channelId", async () => {
		installFetch({ "https://x.test/a.png": { status: 200, contentType: "image/png" } });
		const { runtime, sentPrimary } = makeRuntimeAndBot();
		const result = await telegramSendMediaAction.handler(
			runtime,
			makeMessage(),
			undefined,
			{ parameters: { mediaUrls: ["https://x.test/a.png"], chatId: "5555" } },
		);
		expect(result?.success).toBe(true);
		expect(sentPrimary[0]?.chatId).toBe("5555");
	});

	test("parses chatId:threadId from room.channelId", async () => {
		installFetch({ "https://x.test/a.png": { status: 200, contentType: "image/png" } });
		const { runtime, sentPrimary } = makeRuntimeAndBot();
		// Override getRoom to return a threaded channelId
		(runtime as unknown as { getRoom: (id: string) => Promise<{ channelId: string }> }).getRoom = async () => ({ channelId: "9001:777" });
		const result = await telegramSendMediaAction.handler(
			runtime,
			makeMessage(),
			undefined,
			{ parameters: { mediaUrls: ["https://x.test/a.png"] } },
		);
		expect(result?.success).toBe(true);
		expect(sentPrimary[0]?.chatId).toBe("9001");
		expect(sentPrimary[0]?.extra?.message_thread_id).toBe(777);
	});
});
