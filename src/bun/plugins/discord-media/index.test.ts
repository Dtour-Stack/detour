import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import type { HandlerCallback, IAgentRuntime, Memory } from "@elizaos/core";
import { detourDiscordMediaPlugin, discordSendMediaAction } from "./index";

type ChannelSendArgs = {
	content?: string;
	files?: Array<{ attachment: Buffer; name: string }>;
};

interface FakeChannel {
	id: string;
	send(opts: ChannelSendArgs): Promise<{ id: string }>;
	isTextBased?(): boolean;
}

interface FakeRuntime {
	getService: (name: string) => unknown;
	getRoom: (id: string) => Promise<{ channelId?: string } | null>;
}

const FETCH = globalThis.fetch;

function pngBytes(n = 64): Uint8Array {
	const out = new Uint8Array(n);
	out[0] = 0x89; out[1] = 0x50; out[2] = 0x4e; out[3] = 0x47;
	return out;
}

function installFetch(map: Record<string, { status: number; bytes?: Uint8Array; contentType?: string }>): void {
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = String(input);
		const hit = map[url];
		if (!hit) return new Response("not found", { status: 404 });
		// Use Blob to bridge Uint8Array (TS Response body typing dislikes the
		// raw Uint8Array under TS 5.x stricter signatures).
		const body = new Blob(
			hit.bytes ? [hit.bytes.slice().buffer] : [],
			hit.contentType ? { type: hit.contentType } : undefined,
		);
		return new Response(body, {
			status: hit.status,
			headers: hit.contentType ? { "content-type": hit.contentType } : {},
		});
	}) as typeof fetch;
}

function makeRuntimeAndChannel(): {
	runtime: FakeRuntime;
	channel: FakeChannel;
	sentCalls: ChannelSendArgs[];
} {
	const sentCalls: ChannelSendArgs[] = [];
	const channel: FakeChannel = {
		id: "chan-123",
		isTextBased: () => true,
		send: async (opts) => {
			sentCalls.push(opts);
			return { id: "msg-999" };
		},
	};
	const runtime: FakeRuntime = {
		getService: (name) =>
			name === "discord"
				? {
					client: {
						channels: { fetch: async (id: string) => (id === "chan-123" ? channel : null) },
					},
				}
				: undefined,
		getRoom: async () => ({ channelId: "chan-123" }),
	};
	return { runtime, channel, sentCalls };
}

function makeMessage(): Memory {
	return {
		id: "m-1",
		entityId: "e-1",
		roomId: "r-1",
		content: { source: "discord" },
	} as unknown as Memory;
}

afterEach(() => {
	globalThis.fetch = FETCH;
});

describe("DISCORD_SEND_MEDIA action", () => {
	test("plugin exposes only DISCORD_SEND_MEDIA", () => {
		expect(detourDiscordMediaPlugin.actions?.map((a) => a.name)).toEqual(["DISCORD_SEND_MEDIA"]);
	});

	test("validate returns false when discord service is missing", async () => {
		const runtime = { getService: () => undefined } as unknown as IAgentRuntime;
		const ok = await discordSendMediaAction.validate(runtime, {} as Memory);
		expect(ok).toBe(false);
	});

	test("validate returns true when service has a client", async () => {
		const runtime = { getService: () => ({ client: {} }) } as unknown as IAgentRuntime;
		const ok = await discordSendMediaAction.validate(runtime, {} as Memory);
		expect(ok).toBe(true);
	});

	test("downloads media and sends as attachment", async () => {
		installFetch({
			"https://example.com/cat.png": { status: 200, bytes: pngBytes(), contentType: "image/png" },
		});
		const { runtime, sentCalls } = makeRuntimeAndChannel();
		const cbCalls: string[] = [];
		const cb: HandlerCallback = async (p) => { if (typeof p.text === "string") cbCalls.push(p.text); return []; };
		const result = await discordSendMediaAction.handler(
			runtime as unknown as IAgentRuntime,
			makeMessage(),
			undefined,
			{ parameters: { mediaUrls: ["https://example.com/cat.png"], text: "look at this" } },
			cb,
		);
		expect(result?.success).toBe(true);
		expect(sentCalls).toHaveLength(1);
		expect(sentCalls[0]?.content).toBe("look at this");
		expect(sentCalls[0]?.files).toHaveLength(1);
		expect(sentCalls[0]?.files?.[0]?.name).toBe("cat.png");
		expect(cbCalls[0]).toContain("1 attachment");
	});

	test("accepts single imageUrl alias", async () => {
		installFetch({
			"https://example.com/x.png": { status: 200, bytes: pngBytes(), contentType: "image/png" },
		});
		const { runtime, sentCalls } = makeRuntimeAndChannel();
		const result = await discordSendMediaAction.handler(
			runtime as unknown as IAgentRuntime,
			makeMessage(),
			undefined,
			{ parameters: { imageUrl: "https://example.com/x.png" } },
		);
		expect(result?.success).toBe(true);
		expect(sentCalls[0]?.files).toHaveLength(1);
	});

	test("caps at 10 attachments", async () => {
		const urls = Array.from({ length: 15 }, (_, i) => `https://example.com/${i}.png`);
		const fetchMap: Record<string, { status: number; bytes: Uint8Array; contentType: string }> = {};
		for (const u of urls) fetchMap[u] = { status: 200, bytes: pngBytes(), contentType: "image/png" };
		installFetch(fetchMap);
		const { runtime, sentCalls } = makeRuntimeAndChannel();
		const result = await discordSendMediaAction.handler(
			runtime as unknown as IAgentRuntime,
			makeMessage(),
			undefined,
			{ parameters: { mediaUrls: urls } },
		);
		expect(result?.success).toBe(true);
		expect(sentCalls[0]?.files).toHaveLength(10);
	});

	test("partial-attach: continues when some URLs fail to download", async () => {
		installFetch({
			"https://example.com/ok.png": { status: 200, bytes: pngBytes(), contentType: "image/png" },
			"https://example.com/bad.png": { status: 500 },
		});
		const { runtime, sentCalls } = makeRuntimeAndChannel();
		const result = await discordSendMediaAction.handler(
			runtime as unknown as IAgentRuntime,
			makeMessage(),
			undefined,
			{ parameters: { mediaUrls: ["https://example.com/ok.png", "https://example.com/bad.png"] } },
		);
		expect(result?.success).toBe(true);
		expect(sentCalls[0]?.files).toHaveLength(1);
		expect((result?.data as { warnings: string[] }).warnings[0]).toContain("HTTP 500");
	});

	test("rejects when zero media URLs supplied", async () => {
		const { runtime, sentCalls } = makeRuntimeAndChannel();
		const result = await discordSendMediaAction.handler(
			runtime as unknown as IAgentRuntime,
			makeMessage(),
			undefined,
			{ parameters: { text: "no media here" } },
		);
		expect(result?.success).toBe(false);
		expect(sentCalls).toHaveLength(0);
	});

	test("fails cleanly when all URLs fail to download", async () => {
		installFetch({
			"https://example.com/bad.png": { status: 500 },
		});
		const { runtime, sentCalls } = makeRuntimeAndChannel();
		const result = await discordSendMediaAction.handler(
			runtime as unknown as IAgentRuntime,
			makeMessage(),
			undefined,
			{ parameters: { mediaUrls: ["https://example.com/bad.png"] } },
		);
		expect(result?.success).toBe(false);
		expect(result?.error).toBe("all downloads failed");
		expect(sentCalls).toHaveLength(0);
	});

	test("uses explicit channelId when provided", async () => {
		installFetch({
			"https://example.com/cat.png": { status: 200, bytes: pngBytes(), contentType: "image/png" },
		});
		const { runtime } = makeRuntimeAndChannel();
		const result = await discordSendMediaAction.handler(
			runtime as unknown as IAgentRuntime,
			makeMessage(),
			undefined,
			{ parameters: { mediaUrls: ["https://example.com/cat.png"], channelId: "chan-123" } },
		);
		expect(result?.success).toBe(true);
	});

	test("fails when channel resolution returns null and no explicit channel", async () => {
		installFetch({
			"https://example.com/cat.png": { status: 200, bytes: pngBytes(), contentType: "image/png" },
		});
		const runtime: FakeRuntime = {
			getService: () => ({ client: { channels: { fetch: async () => null } } }),
			getRoom: async () => null,
		};
		const result = await discordSendMediaAction.handler(
			runtime as unknown as IAgentRuntime,
			makeMessage(),
			undefined,
			{ parameters: { mediaUrls: ["https://example.com/cat.png"] } },
		);
		expect(result?.success).toBe(false);
		expect(result?.error).toBe("no channel");
	});
});
