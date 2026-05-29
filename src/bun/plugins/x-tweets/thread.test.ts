import { describe, expect, test } from "bun:test";
import { XClient } from "./x-client";

describe("postThread", () => {
	test("posts first segment as a tweet, chains the rest as replies to the prior id", async () => {
		const c = new XClient({ cookies: { authToken: "a", ct0: "b" } });
		const calls: Array<{ kind: string; text: string; replyTo?: string }> = [];
		let n = 0;
		(c as unknown as { tweet: unknown }).tweet = async (text: string) => {
			calls.push({ kind: "tweet", text });
			return { success: true, tweetId: String(++n) };
		};
		(c as unknown as { reply: unknown }).reply = async (text: string, replyTo: string) => {
			calls.push({ kind: "reply", text, replyTo });
			return { success: true, tweetId: String(++n) };
		};
		const res = await c.postThread(["one", "two", "three"]);
		expect(res.success).toBe(true);
		expect(res.tweetIds).toEqual(["1", "2", "3"]);
		expect(calls[1]).toEqual({ kind: "reply", text: "two", replyTo: "1" });
		expect(calls[2]).toEqual({ kind: "reply", text: "three", replyTo: "2" });
	});

	test("stops and reports on a failed segment", async () => {
		const c = new XClient({ cookies: { authToken: "a", ct0: "b" } });
		(c as unknown as { tweet: unknown }).tweet = async () => ({ success: true, tweetId: "1" });
		(c as unknown as { reply: unknown }).reply = async () => ({ success: false, error: "rate limited" });
		const res = await c.postThread(["one", "two"]);
		expect(res.success).toBe(false);
		expect(res.tweetIds).toEqual(["1"]);
	});
});
