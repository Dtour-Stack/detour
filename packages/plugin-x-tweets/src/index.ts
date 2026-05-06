/**
 * Detour plugin: full agent-callable surface on top of X (Twitter).
 *
 * Auth: cookie-based (`X_AUTH_TOKEN` + `X_CT0`). No developer key.
 *
 * Action set is ordered by what actually moves profile reach in X's
 * open-source ranker (https://github.com/twitter/the-algorithm). Highest-
 * leverage actions for cold-start growth are X_REPLY and X_NOTIFICATIONS
 * (replying fast to mentions hits the AUTHOR_REPLIED ≈ 75× weight). Likes
 * and retweets are useful in volume but each individual one is small.
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
				"X actions require both X_AUTH_TOKEN and X_CT0 in the vault. " +
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

async function emit(callback: HandlerCallback | undefined, text: string, action: string): Promise<void> {
	if (!callback) return;
	await callback({ text, action });
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

function pickNumber(opts: Record<string, unknown> | undefined, keys: string[]): number | undefined {
	if (!opts) return undefined;
	for (const k of keys) {
		const v = opts[k];
		if (typeof v === "number" && Number.isFinite(v)) return v;
		if (typeof v === "string" && v.length > 0 && Number.isFinite(Number(v))) return Number(v);
	}
	return undefined;
}

function withClient<T>(
	runtime: IAgentRuntime,
	callback: HandlerCallback | undefined,
	action: string,
	fn: (client: XClient) => Promise<T>,
): Promise<T | { success: false; error: string }> {
	const { client, error } = buildClient(runtime);
	if (!client) {
		void emit(callback, error ?? "X auth not configured.", action);
		return Promise.resolve({ success: false, error: error ?? "X auth not configured." });
	}
	return fn(client);
}

// ── X_POST ──────────────────────────────────────────────────────────────────

const postHandler: Handler = async (runtime, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const text = pickString(opts, ["text", "content", "tweet", "message"]);
	if (!text) {
		await emit(callback, "X_POST requires a `text` parameter.", "X_POST");
		return { success: false, error: "missing text" };
	}
	if (text.length > 280) {
		logger.info({ src: "x-tweets", len: text.length }, "long-form tweet (>280 chars)");
	}
	return withClient(runtime, callback, "X_POST", async (client) => {
		const r = await client.tweet(text);
		if (!r.success) {
			await emit(callback, `X_POST failed: ${r.error ?? "unknown"}`, "X_POST");
			return { success: false, error: r.error };
		}
		const url = r.url ?? `https://x.com/i/web/status/${r.tweetId}`;
		logger.info({ src: "x-tweets", tweetId: r.tweetId, url }, "X_POST sent");
		await emit(callback, `Posted: ${url}`, "X_POST");
		return { success: true, tweetId: r.tweetId, url };
	});
};

export const xPostAction: Action = {
	name: "X_POST",
	similes: ["TWEET", "POST_TO_X", "POST_TWITTER", "TWEET_OUT"],
	description:
		"Post a new tweet on X (Twitter) as the logged-in account. 280 char limit (25,000 for Premium). " +
		"Returns the URL of the posted tweet.",
	validate: alwaysValid,
	handler: postHandler,
	examples: [],
	parameters: [
		{ name: "text", description: "Tweet body.", required: true, schema: { type: "string" as const } },
	],
} as Action;

// ── X_REPLY ─────────────────────────────────────────────────────────────────

const replyHandler: Handler = async (runtime, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const text = pickString(opts, ["text", "content", "reply", "message"]);
	const replyToTweetId = pickString(opts, ["replyToTweetId", "tweetId", "inReplyTo", "parentId"]);
	if (!text) return missing("X_REPLY", "text", callback);
	if (!replyToTweetId) return missing("X_REPLY", "replyToTweetId", callback);

	return withClient(runtime, callback, "X_REPLY", async (client) => {
		const r = await client.reply(text, replyToTweetId);
		if (!r.success) {
			await emit(callback, `X_REPLY failed: ${r.error ?? "unknown"}`, "X_REPLY");
			return { success: false, error: r.error };
		}
		const url = r.url ?? `https://x.com/i/web/status/${r.tweetId}`;
		logger.info({ src: "x-tweets", tweetId: r.tweetId, replyTo: replyToTweetId }, "X_REPLY sent");
		await emit(callback, `Replied: ${url}`, "X_REPLY");
		return { success: true, tweetId: r.tweetId, url };
	});
};

export const xReplyAction: Action = {
	name: "X_REPLY",
	similes: ["REPLY_TO_TWEET", "REPLY_TO_X", "TWEET_REPLY"],
	description:
		"Reply to a tweet by its numeric ID. **Highest-leverage growth action**: in X's open-source " +
		"ranker, AUTHOR_REPLIED ≈ 75× and engaging-reply ≈ 13.5× — fast replies on mentions and on " +
		"replies to your own posts move reach more than any other engagement.",
	validate: alwaysValid,
	handler: replyHandler,
	examples: [],
	parameters: [
		{ name: "text", description: "Reply body.", required: true, schema: { type: "string" as const } },
		{
			name: "replyToTweetId",
			description: "Numeric tweet ID being replied to (from x.com/.../status/<id>).",
			required: true,
			schema: { type: "string" as const },
		},
	],
} as Action;

// ── X_LIKE ──────────────────────────────────────────────────────────────────

const likeHandler: Handler = async (runtime, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const tweetId = pickString(opts, ["tweetId", "id"]);
	if (!tweetId) return missing("X_LIKE", "tweetId", callback);
	return withClient(runtime, callback, "X_LIKE", async (client) => {
		const r = await client.like(tweetId);
		await emit(callback, r.success ? `Liked ${tweetId}` : `X_LIKE failed: ${r.error}`, "X_LIKE");
		return r;
	});
};

export const xLikeAction: Action = {
	name: "X_LIKE",
	similes: ["LIKE_TWEET", "FAVORITE_TWEET", "HEART_TWEET"],
	description:
		"Like a tweet by ID. Cheap engagement signal (≈0.5× weight) but easy to do in volume — " +
		"liking @-mentions and replies to your own posts is good etiquette and a tiny ranker boost.",
	validate: alwaysValid,
	handler: likeHandler,
	examples: [],
	parameters: [
		{ name: "tweetId", description: "Numeric tweet ID to like.", required: true, schema: { type: "string" as const } },
	],
} as Action;

// ── X_UNLIKE ────────────────────────────────────────────────────────────────

const unlikeHandler: Handler = async (runtime, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const tweetId = pickString(opts, ["tweetId", "id"]);
	if (!tweetId) return missing("X_UNLIKE", "tweetId", callback);
	return withClient(runtime, callback, "X_UNLIKE", async (client) => {
		const r = await client.unlike(tweetId);
		await emit(callback, r.success ? `Unliked ${tweetId}` : `X_UNLIKE failed: ${r.error}`, "X_UNLIKE");
		return r;
	});
};

export const xUnlikeAction: Action = {
	name: "X_UNLIKE",
	similes: ["UNFAVORITE_TWEET", "UNHEART_TWEET"],
	description: "Remove a like from a tweet.",
	validate: alwaysValid,
	handler: unlikeHandler,
	examples: [],
	parameters: [
		{ name: "tweetId", description: "Numeric tweet ID.", required: true, schema: { type: "string" as const } },
	],
} as Action;

// ── X_RETWEET ───────────────────────────────────────────────────────────────

const retweetHandler: Handler = async (runtime, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const tweetId = pickString(opts, ["tweetId", "id"]);
	if (!tweetId) return missing("X_RETWEET", "tweetId", callback);
	return withClient(runtime, callback, "X_RETWEET", async (client) => {
		const r = await client.retweet(tweetId);
		await emit(callback, r.success ? `Retweeted ${tweetId} → ${r.url}` : `X_RETWEET failed: ${r.error}`, "X_RETWEET");
		return r;
	});
};

export const xRetweetAction: Action = {
	name: "X_RETWEET",
	similes: ["RETWEET", "RT", "AMPLIFY_TWEET"],
	description:
		"Retweet (boost) a tweet. RETWEETED ≈ 1× ranker weight — modest but visible to your followers " +
		"and helps the original author. Use on @dEXploarer's posts and other accounts in our orbit.",
	validate: alwaysValid,
	handler: retweetHandler,
	examples: [],
	parameters: [
		{ name: "tweetId", description: "Numeric tweet ID.", required: true, schema: { type: "string" as const } },
	],
} as Action;

// ── X_DELETE_TWEET ──────────────────────────────────────────────────────────

const deleteTweetHandler: Handler = async (runtime, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const tweetId = pickString(opts, ["tweetId", "id"]);
	if (!tweetId) return missing("X_DELETE_TWEET", "tweetId", callback);
	return withClient(runtime, callback, "X_DELETE_TWEET", async (client) => {
		const r = await client.deleteTweet(tweetId);
		await emit(callback, r.success ? `Deleted ${tweetId}` : `X_DELETE_TWEET failed: ${r.error}`, "X_DELETE_TWEET");
		return r;
	});
};

export const xDeleteTweetAction: Action = {
	name: "X_DELETE_TWEET",
	similes: ["DELETE_TWEET", "REMOVE_TWEET", "UNTWEET"],
	description: "Delete one of your own tweets by ID. Irreversible.",
	validate: alwaysValid,
	handler: deleteTweetHandler,
	examples: [],
	parameters: [
		{ name: "tweetId", description: "Numeric tweet ID to delete.", required: true, schema: { type: "string" as const } },
	],
} as Action;

// ── X_BOOKMARK ──────────────────────────────────────────────────────────────

const bookmarkHandler: Handler = async (runtime, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const tweetId = pickString(opts, ["tweetId", "id"]);
	if (!tweetId) return missing("X_BOOKMARK", "tweetId", callback);
	return withClient(runtime, callback, "X_BOOKMARK", async (client) => {
		const r = await client.bookmark(tweetId);
		await emit(callback, r.success ? `Bookmarked ${tweetId}` : `X_BOOKMARK failed: ${r.error}`, "X_BOOKMARK");
		return r;
	});
};

export const xBookmarkAction: Action = {
	name: "X_BOOKMARK",
	similes: ["BOOKMARK_TWEET", "SAVE_TWEET"],
	description: "Bookmark a tweet (private save). BOOKMARKED ≈ 1× engagement signal in the ranker.",
	validate: alwaysValid,
	handler: bookmarkHandler,
	examples: [],
	parameters: [
		{ name: "tweetId", description: "Numeric tweet ID.", required: true, schema: { type: "string" as const } },
	],
} as Action;

// ── X_FOLLOW ────────────────────────────────────────────────────────────────

const followHandler: Handler = async (runtime, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const userId = pickString(opts, ["userId", "id"]);
	const screenName = pickString(opts, ["screenName", "handle", "username"]);
	if (!userId && !screenName) return missing("X_FOLLOW", "userId or screenName", callback);
	return withClient(runtime, callback, "X_FOLLOW", async (client) => {
		let resolvedId = userId;
		if (!resolvedId && screenName) {
			const u = await client.getUserByScreenName(screenName);
			if (!u) {
				await emit(callback, `X_FOLLOW: user @${screenName} not found`, "X_FOLLOW");
				return { success: false, error: "user not found" };
			}
			resolvedId = u.userId;
		}
		const r = await client.follow(resolvedId!);
		await emit(callback, r.success ? `Followed ${screenName ?? resolvedId}` : `X_FOLLOW failed: ${r.error}`, "X_FOLLOW");
		return r;
	});
};

export const xFollowAction: Action = {
	name: "X_FOLLOW",
	similes: ["FOLLOW_USER", "ADD_FRIEND_X"],
	description:
		"Follow a user on X by user ID or @handle. Building the follow graph helps put posts in front " +
		"of the right people via the ranker's graph-distance signal.",
	validate: alwaysValid,
	handler: followHandler,
	examples: [],
	parameters: [
		{ name: "screenName", description: "@handle (without the @).", required: false, schema: { type: "string" as const } },
		{ name: "userId", description: "Numeric user ID (alternative to screenName).", required: false, schema: { type: "string" as const } },
	],
} as Action;

// ── X_GET_USER ──────────────────────────────────────────────────────────────

const getUserHandler: Handler = async (runtime, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const screenName = pickString(opts, ["screenName", "handle", "username"]);
	const userId = pickString(opts, ["userId", "id"]);
	if (!screenName && !userId) return missing("X_GET_USER", "screenName or userId", callback);
	return withClient(runtime, callback, "X_GET_USER", async (client) => {
		const u = screenName
			? await client.getUserByScreenName(screenName)
			: await client.getUserById(userId!);
		if (!u) {
			await emit(callback, `X_GET_USER: not found`, "X_GET_USER");
			return { success: false, error: "not found" };
		}
		await emit(
			callback,
			`@${u.screenName} (${u.userId}): ${u.followersCount ?? "?"} followers, ${u.followingCount ?? "?"} following`,
			"X_GET_USER",
		);
		return { success: true, user: u };
	});
};

export const xGetUserAction: Action = {
	name: "X_GET_USER",
	similes: ["LOOKUP_USER", "GET_X_USER", "RESOLVE_HANDLE"],
	description: "Look up a user's profile (ID, follower counts, bio) by @handle or numeric ID.",
	validate: alwaysValid,
	handler: getUserHandler,
	examples: [],
	parameters: [
		{ name: "screenName", description: "@handle (without the @).", required: false, schema: { type: "string" as const } },
		{ name: "userId", description: "Numeric user ID.", required: false, schema: { type: "string" as const } },
	],
} as Action;

// ── X_GET_TWEET ─────────────────────────────────────────────────────────────

const getTweetHandler: Handler = async (runtime, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const tweetId = pickString(opts, ["tweetId", "id"]);
	if (!tweetId) return missing("X_GET_TWEET", "tweetId", callback);
	return withClient(runtime, callback, "X_GET_TWEET", async (client) => {
		const t = await client.getTweet(tweetId);
		if (!t) {
			await emit(callback, `X_GET_TWEET: not found`, "X_GET_TWEET");
			return { success: false, error: "not found" };
		}
		await emit(
			callback,
			`@${t.authorScreenName ?? "?"}: ${t.text}\n(♥ ${t.favoriteCount ?? 0} | RT ${t.retweetCount ?? 0} | reply ${t.replyCount ?? 0})`,
			"X_GET_TWEET",
		);
		return { success: true, tweet: t };
	});
};

export const xGetTweetAction: Action = {
	name: "X_GET_TWEET",
	similes: ["READ_TWEET", "FETCH_TWEET", "TWEET_DETAIL"],
	description: "Fetch the text + engagement counts for a tweet by ID. Useful before deciding to engage.",
	validate: alwaysValid,
	handler: getTweetHandler,
	examples: [],
	parameters: [
		{ name: "tweetId", description: "Numeric tweet ID.", required: true, schema: { type: "string" as const } },
	],
} as Action;

// ── X_USER_TWEETS ───────────────────────────────────────────────────────────

const userTweetsHandler: Handler = async (runtime, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const screenName = pickString(opts, ["screenName", "handle", "username"]);
	const userId = pickString(opts, ["userId", "id"]);
	const limit = pickNumber(opts, ["limit", "count"]) ?? 10;
	if (!screenName && !userId) return missing("X_USER_TWEETS", "screenName or userId", callback);
	return withClient(runtime, callback, "X_USER_TWEETS", async (client) => {
		let resolvedId = userId;
		if (!resolvedId && screenName) {
			const u = await client.getUserByScreenName(screenName);
			if (!u) {
				await emit(callback, `X_USER_TWEETS: user not found`, "X_USER_TWEETS");
				return { success: false, error: "user not found" };
			}
			resolvedId = u.userId;
		}
		const tweets = await client.getUserTweets(resolvedId!, limit);
		const summary = tweets
			.slice(0, 5)
			.map((t) => `• ${t.text.slice(0, 100)}${t.text.length > 100 ? "…" : ""} (${t.url})`)
			.join("\n");
		await emit(callback, `${tweets.length} tweets:\n${summary}`, "X_USER_TWEETS");
		return { success: true, tweets };
	});
};

export const xUserTweetsAction: Action = {
	name: "X_USER_TWEETS",
	similes: ["GET_USER_TWEETS", "LIST_TWEETS", "READ_USER_TWEETS"],
	description:
		"List recent tweets by @handle or user ID. Use to surface posts to engage with — especially " +
		"on @dEXploarer (cross-engagement boosts both accounts via the graph-distance signal).",
	validate: alwaysValid,
	handler: userTweetsHandler,
	examples: [],
	parameters: [
		{ name: "screenName", description: "@handle.", required: false, schema: { type: "string" as const } },
		{ name: "userId", description: "Numeric user ID.", required: false, schema: { type: "string" as const } },
		{ name: "limit", description: "How many tweets to fetch (default 10).", required: false, schema: { type: "number" as const } },
	],
} as Action;

// ── X_SEARCH ────────────────────────────────────────────────────────────────

const searchHandler: Handler = async (runtime, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const query = pickString(opts, ["query", "q", "search"]);
	const limit = pickNumber(opts, ["limit", "count"]) ?? 20;
	if (!query) return missing("X_SEARCH", "query", callback);
	const product = (pickString(opts, ["product", "mode"]) as
		| "Top"
		| "Latest"
		| "People"
		| "Photos"
		| "Videos"
		| undefined) ?? "Latest";
	return withClient(runtime, callback, "X_SEARCH", async (client) => {
		const tweets = await client.search({ query, limit, product });
		const summary = tweets
			.slice(0, 5)
			.map((t) => `• @${t.authorScreenName ?? "?"}: ${t.text.slice(0, 100)}${t.text.length > 100 ? "…" : ""}`)
			.join("\n");
		await emit(callback, `${tweets.length} results for "${query}":\n${summary}`, "X_SEARCH");
		return { success: true, tweets };
	});
};

export const xSearchAction: Action = {
	name: "X_SEARCH",
	similes: ["SEARCH_X", "SEARCH_TWITTER", "FIND_TWEETS"],
	description:
		"Search X for tweets matching a query. Find conversations to engage in — searching for " +
		"`elizaos`, `agent framework`, project-specific keywords, etc. Returns recent tweets by default.",
	validate: alwaysValid,
	handler: searchHandler,
	examples: [],
	parameters: [
		{ name: "query", description: "Search query (supports X's advanced operators).", required: true, schema: { type: "string" as const } },
		{ name: "product", description: "Top | Latest | People | Photos | Videos. Default Latest.", required: false, schema: { type: "string" as const } },
		{ name: "limit", description: "Max results (default 20).", required: false, schema: { type: "number" as const } },
	],
} as Action;

// ── X_HOME_TIMELINE ─────────────────────────────────────────────────────────

const homeTimelineHandler: Handler = async (runtime, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const limit = pickNumber(opts, ["limit", "count"]) ?? 20;
	return withClient(runtime, callback, "X_HOME_TIMELINE", async (client) => {
		const tweets = await client.getHomeTimeline(limit);
		await emit(callback, `Home timeline: ${tweets.length} tweets`, "X_HOME_TIMELINE");
		return { success: true, tweets };
	});
};

export const xHomeTimelineAction: Action = {
	name: "X_HOME_TIMELINE",
	similes: ["READ_TIMELINE", "X_TIMELINE", "FEED"],
	description: "Read the logged-in user's home timeline (latest mode). Useful for context.",
	validate: alwaysValid,
	handler: homeTimelineHandler,
	examples: [],
	parameters: [
		{ name: "limit", description: "Max tweets (default 20).", required: false, schema: { type: "number" as const } },
	],
} as Action;

// ── X_NOTIFICATIONS ─────────────────────────────────────────────────────────

const notificationsHandler: Handler = async (runtime, _m, _s, _options, callback) => {
	return withClient(runtime, callback, "X_NOTIFICATIONS", async (client) => {
		const notifs = await client.getNotifications();
		const summary = notifs
			.slice(0, 10)
			.map((n) => `• [${n.kind}] ${n.fromUserScreenName ? `@${n.fromUserScreenName}` : ""} ${n.message ?? ""} ${n.tweetId ? `(tweet ${n.tweetId})` : ""}`)
			.join("\n");
		await emit(callback, `${notifs.length} notifications:\n${summary}`, "X_NOTIFICATIONS");
		return { success: true, notifications: notifs };
	});
};

export const xNotificationsAction: Action = {
	name: "X_NOTIFICATIONS",
	similes: ["READ_NOTIFICATIONS", "CHECK_MENTIONS", "X_MENTIONS"],
	description:
		"Read recent notifications (mentions, replies, likes, follows). **Pair with X_REPLY** for the " +
		"highest-leverage growth move: replying fast to mentions hits AUTHOR_REPLIED ≈ 75× weight in " +
		"X's ranker. Poll often.",
	validate: alwaysValid,
	handler: notificationsHandler,
	examples: [],
	parameters: [],
} as Action;

// ── Helpers ─────────────────────────────────────────────────────────────────

async function missing(action: string, field: string, callback: HandlerCallback | undefined) {
	const msg = `${action} requires a \`${field}\` parameter.`;
	await emit(callback, msg, action);
	return { success: false, error: msg };
}

// ── Plugin export ───────────────────────────────────────────────────────────

export const xTweetsPlugin: Plugin = {
	name: "x-tweets",
	description:
		"Full agent-callable surface on X (Twitter) via cookie auth. Includes post, reply, like, " +
		"retweet, bookmark, delete, follow, search, get-user, get-tweet, user-tweets, home-timeline, " +
		"notifications. Reads X_AUTH_TOKEN + X_CT0 from the vault. " +
		"Action priorities follow X's open-source ranker: X_REPLY (especially fast on mentions) is " +
		"the highest-leverage move (AUTHOR_REPLIED ≈ 75× weight); X_NOTIFICATIONS surfaces what to " +
		"reply to; X_LIKE/X_RETWEET are good in volume but each is a small signal.",
	actions: [
		xPostAction,
		xReplyAction,
		xNotificationsAction,
		xLikeAction,
		xUnlikeAction,
		xRetweetAction,
		xBookmarkAction,
		xDeleteTweetAction,
		xFollowAction,
		xSearchAction,
		xGetUserAction,
		xGetTweetAction,
		xUserTweetsAction,
		xHomeTimelineAction,
	],
};

export default xTweetsPlugin;
export { XClient } from "./x-client";
export type { XCookies, XPostResult, XClientOptions, XViewer, XTweetSummary, XUserSummary, XSearchOptions, XNotification } from "./x-client";
