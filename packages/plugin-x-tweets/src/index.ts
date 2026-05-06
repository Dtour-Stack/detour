/**
 * Detour plugin: post + reply to X (Twitter) as the logged-in user.
 *
 * Two actions exposed to the agent:
 *   - X_POST:  text → posts a new tweet
 *   - X_REPLY: text + replyToTweetId → replies to an existing tweet
 *
 * Both call the same X web GraphQL `CreateTweet` endpoint that the official
 * x.com web app uses. Auth is cookie-based (`X_AUTH_TOKEN` + `X_CT0` from
 * the user's vault — Cookie-Editor extension is the standard recipe).
 *
 * No developer API key, no monthly bill, no rate-limited dev tier.
 *
 * Setup (paste in Detour's vault inventory):
 *   X_AUTH_TOKEN  — the `auth_token` cookie from x.com
 *   X_CT0         — the `ct0` cookie from x.com
 *
 * Optional: X_USER_AGENT to override the default browser UA string. The
 * default UA matches a current Chrome on macOS so X's anti-bot doesn't flag
 * the requests as automated.
 *
 * Heads up: based on the public, undocumented X web GraphQL surface (same as
 * @steipete/bird). X rotates the `CreateTweet` queryId every few months — if
 * posting starts 404'ing, refresh `CREATE_TWEET_QUERY_ID` in `x-client.ts`
 * from a current bird build. The plugin already auto-falls back to the
 * legacy v1.1 `statuses/update.json` endpoint on 404 / error 226.
 */

import {
	type Action,
	type Handler,
	type HandlerCallback,
	type IAgentRuntime,
	logger,
	type Plugin,
} from "@elizaos/core";
import { XClient } from "./x-client";

function pickSetting(runtime: IAgentRuntime, key: string): string | undefined {
	const v = runtime.getSetting(key);
	if (typeof v === "string" && v.length > 0) return v;
	const env = process.env[key];
	if (typeof env === "string" && env.length > 0) return env;
	return undefined;
}

function buildClient(runtime: IAgentRuntime): { client?: XClient; error?: string } {
	const authToken = pickSetting(runtime, "X_AUTH_TOKEN");
	const ct0 = pickSetting(runtime, "X_CT0");
	const userAgent = pickSetting(runtime, "X_USER_AGENT");
	if (!authToken || !ct0) {
		return {
			error:
				"X_POST requires both X_AUTH_TOKEN and X_CT0 in the vault. " +
				"Sign in to x.com, export those two cookies via the Cookie-Editor browser extension, " +
				"and paste them into Detour's vault inventory.",
		};
	}
	try {
		return {
			client: new XClient({
				cookies: { authToken, ct0 },
				...(userAgent ? { userAgent } : {}),
			}),
		};
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

async function emit(
	callback: HandlerCallback | undefined,
	text: string,
	actionName: string,
): Promise<void> {
	if (!callback) return;
	await callback({ text, action: actionName });
}

const alwaysValid: Action["validate"] = async () => true;

function pickString(opts: Record<string, unknown> | undefined, keys: string[]): string | undefined {
	if (!opts) return undefined;
	for (const k of keys) {
		const v = opts[k];
		if (typeof v === "string" && v.length > 0) return v;
	}
	return undefined;
}

// ── X_POST ──────────────────────────────────────────────────────────────────

const postHandler: Handler = async (runtime, _message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const text = pickString(opts, ["text", "content", "tweet", "message"]);
	if (!text) {
		await emit(callback, "X_POST requires a `text` parameter.", "X_POST");
		return { success: false, error: "missing text" };
	}
	if (text.length > 280 && text.length <= 25_000) {
		// X allows long-form notes for Premium accounts; we let the API decide.
		logger.info({ src: "x-tweets", len: text.length }, "long-form tweet (>280 chars)");
	}

	const { client, error } = buildClient(runtime);
	if (!client) {
		await emit(callback, error ?? "X auth not configured.", "X_POST");
		return { success: false, error };
	}

	const result = await client.tweet(text);
	if (!result.success) {
		const msg = `X_POST failed: ${result.error ?? "unknown"}`;
		logger.warn({ src: "x-tweets" }, msg);
		await emit(callback, msg, "X_POST");
		return { success: false, error: result.error };
	}

	const url = result.url ?? `https://x.com/i/web/status/${result.tweetId}`;
	logger.info({ src: "x-tweets", tweetId: result.tweetId, url }, "X_POST sent");
	await emit(callback, `Posted: ${url}`, "X_POST");
	return { success: true, tweetId: result.tweetId, url };
};

export const xPostAction: Action = {
	name: "X_POST",
	similes: ["TWEET", "POST_TO_X", "POST_TWITTER", "TWEET_OUT"],
	description:
		"Post a new tweet on X (Twitter) as the logged-in account. Use when the user asks to post, " +
		"tweet, or share something publicly on X. Body must fit X's character limits (280 chars for " +
		"standard, up to 25,000 for Premium long-form). Returns the URL of the posted tweet.",
	validate: alwaysValid,
	handler: postHandler,
	examples: [],
	parameters: [
		{
			name: "text",
			description: "The tweet body. 280 char standard, longer if posting from a Premium account.",
			required: true,
			schema: { type: "string" as const },
		},
	],
} as Action;

// ── X_REPLY ─────────────────────────────────────────────────────────────────

const replyHandler: Handler = async (runtime, _message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const text = pickString(opts, ["text", "content", "reply", "message"]);
	const replyToTweetId = pickString(opts, ["replyToTweetId", "tweetId", "inReplyTo", "parentId"]);
	if (!text) {
		await emit(callback, "X_REPLY requires a `text` parameter.", "X_REPLY");
		return { success: false, error: "missing text" };
	}
	if (!replyToTweetId) {
		await emit(callback, "X_REPLY requires a `replyToTweetId`.", "X_REPLY");
		return { success: false, error: "missing replyToTweetId" };
	}

	const { client, error } = buildClient(runtime);
	if (!client) {
		await emit(callback, error ?? "X auth not configured.", "X_REPLY");
		return { success: false, error };
	}

	const result = await client.reply(text, replyToTweetId);
	if (!result.success) {
		const msg = `X_REPLY failed: ${result.error ?? "unknown"}`;
		logger.warn({ src: "x-tweets" }, msg);
		await emit(callback, msg, "X_REPLY");
		return { success: false, error: result.error };
	}

	const url = result.url ?? `https://x.com/i/web/status/${result.tweetId}`;
	logger.info({ src: "x-tweets", tweetId: result.tweetId, replyTo: replyToTweetId, url }, "X_REPLY sent");
	await emit(callback, `Replied: ${url}`, "X_REPLY");
	return { success: true, tweetId: result.tweetId, url };
};

export const xReplyAction: Action = {
	name: "X_REPLY",
	similes: ["REPLY_TO_TWEET", "REPLY_TO_X", "TWEET_REPLY"],
	description:
		"Reply to an existing tweet on X (Twitter). Use when the user asks to respond to or " +
		"comment on a specific tweet. Requires the parent tweet's ID (the long numeric ID from " +
		"the tweet URL). Returns the URL of the posted reply.",
	validate: alwaysValid,
	handler: replyHandler,
	examples: [],
	parameters: [
		{
			name: "text",
			description: "The reply body.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "replyToTweetId",
			description: "The numeric ID of the tweet being replied to (from the URL: x.com/.../status/<id>).",
			required: true,
			schema: { type: "string" as const },
		},
	],
} as Action;

// ── Plugin export ───────────────────────────────────────────────────────────

export const xTweetsPlugin: Plugin = {
	name: "x-tweets",
	description:
		"Lets the agent post + reply on X (Twitter) using cookie auth. No developer API key needed. " +
		"Reads X_AUTH_TOKEN + X_CT0 from the vault.",
	actions: [xPostAction, xReplyAction],
};

export default xTweetsPlugin;
export { XClient } from "./x-client";
export type { XCookies, XPostResult, XClientOptions } from "./x-client";
