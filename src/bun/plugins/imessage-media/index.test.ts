import { describe, expect, test, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import type { HandlerCallback, IAgentRuntime, Memory } from "@elizaos/core";
import { detourIMessageMediaPlugin, extensionFor, imessageSendMediaAction } from "./index";

const FETCH = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = FETCH;
});

function installFetch(map: Record<string, { status: number; contentType?: string; bytes?: Uint8Array }>): void {
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = String(input);
		const hit = map[url];
		if (!hit) return new Response("not found", { status: 404 });
		const headers: Record<string, string> = {};
		if (hit.contentType) headers["content-type"] = hit.contentType;
		return new Response(hit.bytes ? new Blob([hit.bytes.slice().buffer]) : new Blob([]), {
			status: hit.status,
			headers,
		});
	}) as typeof fetch;
}

interface SentCall {
	to: string;
	text: string;
	mediaUrl: string | undefined;
}

function makeRuntimeAndService(opts: {
	isMacOS?: boolean;
	isConnected?: boolean;
	sendFails?: boolean;
	target?: string;
} = {}) {
	const sent: SentCall[] = [];
	const service = {
		isConnected: () => opts.isConnected ?? true,
		isMacOS: () => opts.isMacOS ?? true,
		sendMessage: async (to: string, text: string, sendOpts?: { mediaUrl?: string }) => {
			sent.push({ to, text, mediaUrl: sendOpts?.mediaUrl });
			if (opts.sendFails) return { success: false, error: "fake send failure" };
			return { success: true, messageId: `m-${sent.length}` };
		},
	};
	const runtime = {
		getService: (name: string) => (name === "imessage" ? service : undefined),
		getRoom: async () => ({ channelId: opts.target ?? "+15555550100" }),
	};
	return { runtime: runtime as unknown as IAgentRuntime, sent };
}

function makeMessage(): Memory {
	return {
		id: "m-1",
		entityId: "e-1",
		roomId: "r-1",
		content: { source: "imessage" },
	} as unknown as Memory;
}

describe("extensionFor", () => {
	test("prefers URL extension when present", () => {
		expect(extensionFor("https://x.test/path/foo.png", null)).toBe(".png");
		expect(extensionFor("https://x.test/foo.jpg?signed=true", null)).toBe(".jpg");
	});
	test("falls back to MIME subtype when URL has no extension", () => {
		expect(extensionFor("https://x.test/u", "image/png")).toBe(".png");
		expect(extensionFor("https://x.test/u", "video/mp4")).toBe(".mp4");
	});
	test("normalizes jpeg → jpg", () => {
		expect(extensionFor("https://x.test/u", "image/jpeg")).toBe(".jpg");
	});
	test("strips charset params from MIME", () => {
		expect(extensionFor("https://x.test/u", "image/png; charset=binary")).toBe(".png");
	});
	test("defaults to .bin for unknowns", () => {
		expect(extensionFor("https://x.test/u", null)).toBe(".bin");
	});
});

describe("IMESSAGE_SEND_MEDIA action", () => {
	test("plugin exposes only IMESSAGE_SEND_MEDIA", () => {
		expect(detourIMessageMediaPlugin.actions?.map((a) => a.name)).toEqual(["IMESSAGE_SEND_MEDIA"]);
	});

	test("validate false without service", async () => {
		const runtime = { getService: () => undefined } as unknown as IAgentRuntime;
		expect(await imessageSendMediaAction.validate(runtime, {} as Memory)).toBe(false);
	});

	test("validate false when service reports not-connected", async () => {
		const runtime = {
			getService: () => ({ sendMessage: async () => ({ success: true }), isConnected: () => false, isMacOS: () => true }),
		} as unknown as IAgentRuntime;
		expect(await imessageSendMediaAction.validate(runtime, {} as Memory)).toBe(false);
	});

	test("validate false off macOS", async () => {
		const runtime = {
			getService: () => ({ sendMessage: async () => ({ success: true }), isConnected: () => true, isMacOS: () => false }),
		} as unknown as IAgentRuntime;
		expect(await imessageSendMediaAction.validate(runtime, {} as Memory)).toBe(false);
	});

	test("validate true when service connected on macOS", async () => {
		const runtime = {
			getService: () => ({ sendMessage: async () => ({ success: true }), isConnected: () => true, isMacOS: () => true }),
		} as unknown as IAgentRuntime;
		expect(await imessageSendMediaAction.validate(runtime, {} as Memory)).toBe(true);
	});

	test("downloads URL, sends with local path, cleans up temp file", async () => {
		const bytes = new Uint8Array([1, 2, 3]);
		installFetch({ "https://x.test/cat.png": { status: 200, contentType: "image/png", bytes } });
		const { runtime, sent } = makeRuntimeAndService();
		const cbCalls: string[] = [];
		const cb: HandlerCallback = async (p) => { if (typeof p.text === "string") cbCalls.push(p.text); return []; };
		const result = await imessageSendMediaAction.handler(
			runtime,
			makeMessage(),
			undefined,
			{ parameters: { mediaUrls: ["https://x.test/cat.png"], text: "yo" } },
			cb,
		);
		expect(result?.success).toBe(true);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.to).toBe("+15555550100");
		expect(sent[0]?.text).toBe("yo");
		expect(sent[0]?.mediaUrl).toContain(".png");
		// Cleanup verified: the temp file no longer exists after the send finishes.
		expect(existsSync(sent[0]?.mediaUrl as string)).toBe(false);
		expect(cbCalls[0]).toContain("1 attachment");
	});

	test("explicit `to` overrides room channelId", async () => {
		installFetch({ "https://x.test/a.png": { status: 200, contentType: "image/png", bytes: new Uint8Array([1]) } });
		const { runtime, sent } = makeRuntimeAndService();
		const result = await imessageSendMediaAction.handler(
			runtime,
			makeMessage(),
			undefined,
			{ parameters: { mediaUrls: ["https://x.test/a.png"], to: "shawn@example.com" } },
		);
		expect(result?.success).toBe(true);
		expect(sent[0]?.to).toBe("shawn@example.com");
	});

	test("multiple URLs: first carries text, rest are attachment-only", async () => {
		installFetch({
			"https://x.test/a.png": { status: 200, contentType: "image/png", bytes: new Uint8Array([1]) },
			"https://x.test/b.png": { status: 200, contentType: "image/png", bytes: new Uint8Array([2]) },
		});
		const { runtime, sent } = makeRuntimeAndService();
		const result = await imessageSendMediaAction.handler(
			runtime,
			makeMessage(),
			undefined,
			{ parameters: { mediaUrls: ["https://x.test/a.png", "https://x.test/b.png"], text: "look" } },
		);
		expect(result?.success).toBe(true);
		expect(sent).toHaveLength(2);
		expect(sent[0]?.text).toBe("look");
		expect(sent[1]?.text).toBe("");
	});

	test("partial download failure: continues with surviving files", async () => {
		installFetch({
			"https://x.test/ok.png": { status: 200, contentType: "image/png", bytes: new Uint8Array([1]) },
			"https://x.test/bad.png": { status: 500 },
		});
		const { runtime, sent } = makeRuntimeAndService();
		const result = await imessageSendMediaAction.handler(
			runtime,
			makeMessage(),
			undefined,
			{ parameters: { mediaUrls: ["https://x.test/bad.png", "https://x.test/ok.png"] } },
		);
		expect(result?.success).toBe(true);
		expect(sent).toHaveLength(1);
		expect((result?.data as { warnings: string[] }).warnings[0]).toContain("HTTP 500");
	});

	test("all-downloads-fail returns clean error", async () => {
		installFetch({ "https://x.test/bad.png": { status: 500 } });
		const { runtime, sent } = makeRuntimeAndService();
		const result = await imessageSendMediaAction.handler(
			runtime,
			makeMessage(),
			undefined,
			{ parameters: { mediaUrls: ["https://x.test/bad.png"] } },
		);
		expect(result?.success).toBe(false);
		expect(result?.error).toBe("all downloads failed");
		expect(sent).toHaveLength(0);
	});

	test("send failure surfaces error and still cleans up", async () => {
		installFetch({ "https://x.test/a.png": { status: 200, contentType: "image/png", bytes: new Uint8Array([1]) } });
		const { runtime, sent } = makeRuntimeAndService({ sendFails: true });
		const result = await imessageSendMediaAction.handler(
			runtime,
			makeMessage(),
			undefined,
			{ parameters: { mediaUrls: ["https://x.test/a.png"] } },
		);
		expect(result?.success).toBe(false);
		expect(result?.error).toBe("all sends failed");
		// Cleanup still happened
		expect(existsSync(sent[0]?.mediaUrl as string)).toBe(false);
	});

	test("rejects when no media URLs supplied", async () => {
		const { runtime, sent } = makeRuntimeAndService();
		const result = await imessageSendMediaAction.handler(
			runtime,
			makeMessage(),
			undefined,
			{ parameters: { text: "no media" } },
		);
		expect(result?.success).toBe(false);
		expect(sent).toHaveLength(0);
	});
});
