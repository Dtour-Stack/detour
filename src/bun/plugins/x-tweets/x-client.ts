/**
 * X (Twitter) web GraphQL client. Cookie auth, no developer key.
 *
 * Talks to the same `/i/api/graphql/<queryId>/<Operation>` surface that the
 * official x.com web bundle uses. Auth = `auth_token` + `ct0` cookies that the
 * user exports from a logged-in browser session (Cookie-Editor extension).
 *
 * What this client gives the agent:
 *
 *   - tweet/reply           — create original posts and useful conversation
 *   - like                  — lightweight acknowledgement
 *   - retweet               — public amplification
 *   - bookmark              — private save
 *   - delete                — clean up own posts
 *   - search/getTweet       — find conversations to engage in
 *   - getUser/getUserTweets — read someone's recent activity to engage with
 *   - getNotifications      — handle mentions and replies
 *   - viewer                — confirm we're posting as the right account
 *
 * Heads-up: X rotates queryIds every few months. When something starts 404ing
 * refresh the IDs in `x-query-ids.ts` from a current bundle (instructions in
 * that file's header comment).
 */

import { X_PUBLIC_BEARER, X_QUERY_IDS, buildFeatures } from "./x-query-ids";

const GQL_BASE = "https://x.com/i/api/graphql";
const REST_V11_BASE = "https://x.com/i/api/1.1";
const TWITTER_STATUS_UPDATE_URL = `${REST_V11_BASE}/statuses/update.json`;
const NOTIFICATIONS_URL = "https://x.com/i/api/2/notifications/all.json";
const MEDIA_UPLOAD_URL = "https://upload.twitter.com/i/media/upload.json";
const MEDIA_CHUNK_SIZE = 1_000_000; // 1MB; X's docs cap individual APPEND chunks at 5MB

/**
 * X requires `media_category` set on uploads — picking the right value
 * gates which file types are accepted and whether the processing pipeline
 * waits for transcode. Map common MIME types here; unknown types fall
 * back to `tweet_image` which is the most permissive on the upload side.
 */
export function mediaCategoryForMime(mimeType: string): "tweet_image" | "tweet_gif" | "tweet_video" {
	const m = mimeType.toLowerCase();
	if (m.startsWith("video/")) return "tweet_video";
	if (m === "image/gif") return "tweet_gif";
	return "tweet_image";
}

// ── Public types ────────────────────────────────────────────────────────────

export interface XCookies {
	authToken: string;
	ct0: string;
}

export interface XClientOptions {
	cookies: XCookies;
	timeoutMs?: number;
	userAgent?: string;
}

export interface XPostResult {
	success: boolean;
	tweetId?: string;
	url?: string;
	error?: string;
}

type XCreateTweetResult = {
	rest_id?: string;
	id_str?: string;
	id?: string | number;
	legacy?: {
		id_str?: string;
	};
	tweet?: {
		rest_id?: string;
		id_str?: string;
		legacy?: {
			id_str?: string;
		};
	};
};

type XCreateTweetResponse = {
	errors?: Array<{ code?: number; message?: string }>;
	data?: {
		create_tweet?: {
			tweet_results?: {
				result?: XCreateTweetResult;
			};
		};
	};
};

export interface XViewer {
	userId: string;
	screenName: string;
	name?: string;
}

export interface XTweetSummary {
	tweetId: string;
	authorId?: string;
	authorScreenName?: string;
	text: string;
	createdAt?: string;
	favoriteCount?: number;
	retweetCount?: number;
	replyCount?: number;
	url: string;
}

export interface XUserSummary {
	userId: string;
	screenName: string;
	name?: string;
	description?: string;
	followersCount?: number;
	followingCount?: number;
	verified?: boolean;
}

export interface XSearchOptions {
	query: string;
	limit?: number;
	product?: "Top" | "Latest" | "People" | "Photos" | "Videos";
}

export interface XNotification {
	id: string;
	timestamp: string;
	message?: string;
	tweetId?: string;
	fromUserScreenName?: string;
	kind: "mention" | "reply" | "like" | "retweet" | "follow" | "other";
}

function createTweetResultId(result: XCreateTweetResult | undefined): string | undefined {
	return result?.rest_id
		?? result?.id_str
		?? (result?.id !== undefined ? String(result.id) : undefined)
		?? result?.legacy?.id_str
		?? result?.tweet?.rest_id
		?? result?.tweet?.id_str
		?? result?.tweet?.legacy?.id_str;
}

// ── Client ──────────────────────────────────────────────────────────────────

export class XClient {
	private readonly authToken: string;
	private readonly ct0: string;
	private readonly cookieHeader: string;
	private readonly userAgent: string;
	private readonly timeoutMs: number;
	private readonly clientUuid: string;
	private readonly clientDeviceId: string;

	constructor(opts: XClientOptions) {
		if (!opts.cookies.authToken || !opts.cookies.ct0) {
			throw new Error("XClient: both authToken and ct0 cookies are required");
		}
		this.authToken = opts.cookies.authToken;
		this.ct0 = opts.cookies.ct0;
		this.cookieHeader = `auth_token=${this.authToken}; ct0=${this.ct0}`;
		this.userAgent =
			opts.userAgent ??
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
		this.timeoutMs = opts.timeoutMs ?? 15_000;
		this.clientUuid = crypto.randomUUID();
		this.clientDeviceId = crypto.randomUUID();
	}

	// ── WRITE ────────────────────────────────────────────────────────────────

	async tweet(text: string, opts: { mediaIds?: string[] } = {}): Promise<XPostResult> {
		return this.createTweet({
			tweet_text: text,
			dark_request: false,
			media: {
				media_entities: (opts.mediaIds ?? []).map((id) => ({ media_id: id, tagged_users: [] })),
				possibly_sensitive: false,
			},
			semantic_annotation_ids: [],
		});
	}

	async reply(
		text: string,
		replyToTweetId: string,
		opts: { mediaIds?: string[] } = {},
	): Promise<XPostResult> {
		return this.createTweet({
			tweet_text: text,
			reply: { in_reply_to_tweet_id: replyToTweetId, exclude_reply_user_ids: [] },
			dark_request: false,
			media: {
				media_entities: (opts.mediaIds ?? []).map((id) => ({ media_id: id, tagged_users: [] })),
				possibly_sensitive: false,
			},
			semantic_annotation_ids: [],
		});
	}

	/**
	 * Upload media bytes to X using the chunked v1.1 endpoint (INIT → APPEND →
	 * FINALIZE → STATUS), returning the `media_id_string` the create-tweet
	 * mutation accepts in `media.media_entities[].media_id`.
	 *
	 *   const id = await client.uploadMedia(bytes, "image/png");
	 *   await client.tweet("look at this:", { mediaIds: [id] });
	 *
	 * For video uploads, the server may return `pending` / `in_progress`
	 * after FINALIZE; we poll `command=STATUS` up to ~60s before failing.
	 *
	 * `mediaCategory` is one of "tweet_image" / "tweet_gif" / "tweet_video"
	 * — the upload host rejects videos that come in without the category
	 * set explicitly. Caller passes the right value based on the MIME type
	 * (helper `mediaCategoryForMime` below does the mapping).
	 */
	async uploadMedia(
		bytes: Uint8Array,
		mimeType: string,
		mediaCategory: "tweet_image" | "tweet_gif" | "tweet_video" = mediaCategoryForMime(mimeType),
	): Promise<{ mediaId: string }> {
		const init = await this.mediaCommand({
			command: "INIT",
			total_bytes: String(bytes.length),
			media_type: mimeType,
			media_category: mediaCategory,
		});
		const initJson = (await init.json()) as { media_id_string?: string };
		const mediaId = initJson.media_id_string;
		if (!mediaId) throw new Error("INIT did not return media_id_string");

		let segmentIndex = 0;
		for (let offset = 0; offset < bytes.length; offset += MEDIA_CHUNK_SIZE) {
			const chunk = bytes.subarray(offset, Math.min(offset + MEDIA_CHUNK_SIZE, bytes.length));
			const form = new FormData();
			form.set("command", "APPEND");
			form.set("media_id", mediaId);
			form.set("segment_index", String(segmentIndex));
			// Slice to a fresh ArrayBuffer so the Blob constructor's
			// BlobPart signature accepts it (rejects ArrayBufferLike from
			// Uint8Array's polymorphic backing under TS 5.x).
			const arrayBuffer = chunk.buffer.slice(
				chunk.byteOffset,
				chunk.byteOffset + chunk.byteLength,
			) as ArrayBuffer;
			form.set("media", new Blob([arrayBuffer], { type: mimeType }));
			const res = await this.fetchWithTimeout(MEDIA_UPLOAD_URL, {
				method: "POST",
				headers: this.getBaseHeaders(),
				body: form,
			});
			if (!res.ok) {
				const errText = await res.text().catch(() => "");
				throw new Error(`APPEND segment=${segmentIndex} failed: HTTP ${res.status} ${errText.slice(0, 200)}`);
			}
			segmentIndex++;
		}

		const finalize = await this.mediaCommand({
			command: "FINALIZE",
			media_id: mediaId,
		});
		const finalizeJson = (await finalize.json()) as {
			processing_info?: { state?: string; check_after_secs?: number };
		};
		if (finalizeJson.processing_info?.state && finalizeJson.processing_info.state !== "succeeded") {
			await this.waitForMediaProcessing(mediaId);
		}
		return { mediaId };
	}

	private async mediaCommand(params: Record<string, string>): Promise<Response> {
		const form = new FormData();
		for (const [k, v] of Object.entries(params)) form.set(k, v);
		const res = await this.fetchWithTimeout(MEDIA_UPLOAD_URL, {
			method: "POST",
			headers: this.getBaseHeaders(),
			body: form,
		});
		if (!res.ok) {
			const errText = await res.text().catch(() => "");
			throw new Error(`${params.command} failed: HTTP ${res.status} ${errText.slice(0, 200)}`);
		}
		return res;
	}

	private async waitForMediaProcessing(mediaId: string): Promise<void> {
		const deadline = Date.now() + 60_000;
		let waitMs = 2_000;
		while (Date.now() < deadline) {
			const url = `${MEDIA_UPLOAD_URL}?command=STATUS&media_id=${encodeURIComponent(mediaId)}`;
			const res = await this.fetchWithTimeout(url, { method: "GET", headers: this.getBaseHeaders() });
			if (!res.ok) {
				const errText = await res.text().catch(() => "");
				throw new Error(`STATUS failed: HTTP ${res.status} ${errText.slice(0, 200)}`);
			}
			const json = (await res.json()) as {
				processing_info?: { state?: string; check_after_secs?: number; error?: { message?: string } };
			};
			const state = json.processing_info?.state;
			if (state === "succeeded") return;
			if (state === "failed") {
				const msg = json.processing_info?.error?.message ?? "unknown processing error";
				throw new Error(`media processing failed: ${msg}`);
			}
			const checkAfter = json.processing_info?.check_after_secs;
			waitMs = typeof checkAfter === "number" && checkAfter > 0 ? checkAfter * 1000 : Math.min(waitMs * 2, 8_000);
			await new Promise((resolve) => setTimeout(resolve, waitMs));
		}
		throw new Error("media processing timed out after 60s");
	}

	async like(tweetId: string): Promise<{ success: boolean; error?: string }> {
		return this.mutation(X_QUERY_IDS.FavoriteTweet, "FavoriteTweet", { tweet_id: tweetId }, (data) =>
			(data?.data as { favorite_tweet?: string })?.favorite_tweet === "Done",
		);
	}

	async unlike(tweetId: string): Promise<{ success: boolean; error?: string }> {
		return this.mutation(
			X_QUERY_IDS.UnfavoriteTweet,
			"UnfavoriteTweet",
			{ tweet_id: tweetId },
			(data) => (data?.data as { unfavorite_tweet?: string })?.unfavorite_tweet === "Done",
		);
	}

	async retweet(tweetId: string): Promise<XPostResult> {
		const result = await this.mutationRaw(X_QUERY_IDS.CreateRetweet, "CreateRetweet", {
			tweet_id: tweetId,
			dark_request: false,
		});
		if (!result.ok) return { success: false, error: result.error };
		const data = result.body as {
			data?: { create_retweet?: { retweet_results?: { result?: { rest_id?: string } } } };
		};
		const rt = data.data?.create_retweet?.retweet_results?.result?.rest_id;
		if (!rt) return { success: false, error: "retweet returned no id" };
		return { success: true, tweetId: rt, url: `https://x.com/i/web/status/${rt}` };
	}

	async unretweet(tweetId: string): Promise<{ success: boolean; error?: string }> {
		return this.mutation(
			X_QUERY_IDS.DeleteRetweet,
			"DeleteRetweet",
			{ source_tweet_id: tweetId, dark_request: false },
			() => true,
		);
	}

	async deleteTweet(tweetId: string): Promise<{ success: boolean; error?: string }> {
		return this.mutation(
			X_QUERY_IDS.DeleteTweet,
			"DeleteTweet",
			{ tweet_id: tweetId, dark_request: false },
			() => true,
		);
	}

	async bookmark(tweetId: string): Promise<{ success: boolean; error?: string }> {
		return this.mutation(X_QUERY_IDS.CreateBookmark, "CreateBookmark", { tweet_id: tweetId }, () => true);
	}

	async unbookmark(tweetId: string): Promise<{ success: boolean; error?: string }> {
		return this.mutation(X_QUERY_IDS.DeleteBookmark, "DeleteBookmark", { tweet_id: tweetId }, () => true);
	}

	/** Follow a user. Uses legacy v1.1 endpoint (no GraphQL CreateFriendship in current bundle). */
	async follow(userId: string): Promise<{ success: boolean; error?: string }> {
		const params = new URLSearchParams({ user_id: userId });
		return this.restMutation(`${REST_V11_BASE}/friendships/create.json`, params);
	}

	async unfollow(userId: string): Promise<{ success: boolean; error?: string }> {
		const params = new URLSearchParams({ user_id: userId });
		return this.restMutation(`${REST_V11_BASE}/friendships/destroy.json`, params);
	}

	// ── READ ─────────────────────────────────────────────────────────────────

	/** Returns the logged-in account info — confirms cookies belong to expected user. */
	async viewer(): Promise<XViewer> {
		const data = await this.query(X_QUERY_IDS.Viewer, "Viewer", { withCommunitiesMemberships: true });
		const viewer = (data.data as { viewer?: { user_results?: { result?: ViewerUserResult } } })?.viewer;
		const u = viewer?.user_results?.result;
		const userId = u?.rest_id;
		const screenName = u?.core?.screen_name ?? u?.legacy?.screen_name;
		if (!userId || !screenName) {
			throw new Error("Viewer response missing user identity");
		}
		return { userId, screenName, name: u?.core?.name ?? u?.legacy?.name };
	}

	async getUserByScreenName(screenName: string): Promise<XUserSummary | null> {
		const data = await this.query(X_QUERY_IDS.UserByScreenName, "UserByScreenName", {
			screen_name: screenName,
			withSafetyModeUserFields: true,
		});
		const u = (data.data as { user?: { result?: ViewerUserResult } })?.user?.result;
		if (!u || u.__typename === "UserUnavailable") return null;
		return summarizeUser(u);
	}

	async getUserById(userId: string): Promise<XUserSummary | null> {
		const data = await this.query(X_QUERY_IDS.UserByRestId, "UserByRestId", {
			userId,
			withSafetyModeUserFields: true,
		});
		const u = (data.data as { user?: { result?: ViewerUserResult } })?.user?.result;
		if (!u || u.__typename === "UserUnavailable") return null;
		return summarizeUser(u);
	}

	async getTweet(tweetId: string): Promise<XTweetSummary | null> {
		const data = await this.query(X_QUERY_IDS.TweetDetail, "TweetDetail", {
			focalTweetId: tweetId,
			with_rux_injections: false,
			rankingMode: "Relevance",
			includePromotedContent: false,
			withCommunity: true,
			withQuickPromoteEligibilityTweetFields: true,
			withBirdwatchNotes: true,
			withVoice: true,
		});
		const tweets = collectTweets(data);
		return tweets.find((t) => t.tweetId === tweetId) ?? tweets[0] ?? null;
	}

	async getUserTweets(userId: string, limit = 20): Promise<XTweetSummary[]> {
		const data = await this.query(X_QUERY_IDS.UserTweets, "UserTweets", {
			userId,
			count: limit,
			includePromotedContent: false,
			withQuickPromoteEligibilityTweetFields: false,
			withVoice: true,
			withV2Timeline: true,
		});
		return collectTweets(data).slice(0, limit);
	}

	async search(opts: XSearchOptions): Promise<XTweetSummary[]> {
		const limit = opts.limit ?? 20;
		const data = await this.query(X_QUERY_IDS.SearchTimeline, "SearchTimeline", {
			rawQuery: opts.query,
			count: limit,
			querySource: "typed_query",
			product: opts.product ?? "Latest",
		});
		return collectTweets(data).slice(0, limit);
	}

	async getHomeTimeline(limit = 20): Promise<XTweetSummary[]> {
		const data = await this.query(X_QUERY_IDS.HomeLatestTimeline, "HomeLatestTimeline", {
			count: limit,
			includePromotedContent: false,
			latestControlAvailable: true,
			requestContext: "launch",
			withCommunity: true,
		});
		return collectTweets(data).slice(0, limit);
	}

	/** Recent notifications (mentions, replies, likes, follows). */
	async getNotifications(): Promise<XNotification[]> {
		const res = await this.fetchWithTimeout(NOTIFICATIONS_URL, {
			method: "GET",
			headers: this.getBaseHeaders(),
		});
		if (!res.ok) throw new Error(`getNotifications HTTP ${res.status}`);
		const body = (await res.json()) as RawNotificationsResponse;
		return collectNotifications(body);
	}

	// ── Internals ────────────────────────────────────────────────────────────

	private async createTweet(variables: Record<string, unknown>): Promise<XPostResult> {
		const url = `${GQL_BASE}/${X_QUERY_IDS.CreateTweet}/CreateTweet`;
		const body = JSON.stringify({
			variables,
			features: buildFeatures(),
			queryId: X_QUERY_IDS.CreateTweet,
		});
		const headers = { ...this.getJsonHeaders(), referer: "https://x.com/compose/post" };

		try {
			const response = await this.fetchWithTimeout(url, { method: "POST", headers, body });
			if (response.status === 404) {
				return this.postStatusUpdateFallback(variables);
			}
			if (!response.ok) {
				const text = await response.text();
				return { success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
			}
			const data = (await response.json()) as XCreateTweetResponse;
			if (data.errors && data.errors.length > 0) {
				const fallback = await this.maybeFallbackOnErrors(data.errors, variables);
				if (fallback) return fallback;
				return { success: false, error: this.formatErrors(data.errors) };
			}
			const tweetId = createTweetResultId(data.data?.create_tweet?.tweet_results?.result);
			if (tweetId) {
				return { success: true, tweetId, url: `https://x.com/i/web/status/${tweetId}` };
			}
			const recovered = await this.recoverCreatedTweet(variables);
			if (recovered) return recovered;
			return { success: false, error: "Tweet created but no ID returned" };
		} catch (err) {
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	private async recoverCreatedTweet(variables: Record<string, unknown>): Promise<XPostResult | null> {
		const text = typeof variables.tweet_text === "string" ? variables.tweet_text.trim() : "";
		if (!text) return null;
		const viewer = await this.viewer();
		const tweets = await this.getUserTweets(viewer.userId, 10);
		const match = tweets.find((tweet) => {
			const candidate = tweet.text.trim();
			return candidate === text || candidate.endsWith(text);
		});
		return match ? { success: true, tweetId: match.tweetId, url: match.url } : null;
	}

	/**
	 * v1.1 fallback. Used when GraphQL queryId rotates (404) or when X returns
	 * error 226 ("appears to be automated") which the v1.1 endpoint sometimes
	 * still accepts.
	 */
	private async postStatusUpdateFallback(
		variables: Record<string, unknown>,
	): Promise<XPostResult> {
		const text = typeof variables.tweet_text === "string" ? variables.tweet_text : "";
		if (!text) return { success: false, error: "fallback: no tweet_text" };
		const reply = variables.reply as { in_reply_to_tweet_id?: string } | undefined;
		const params = new URLSearchParams();
		params.set("status", text);
		if (reply?.in_reply_to_tweet_id) {
			params.set("in_reply_to_status_id", reply.in_reply_to_tweet_id);
			params.set("auto_populate_reply_metadata", "true");
		}
		try {
			const res = await this.fetchWithTimeout(TWITTER_STATUS_UPDATE_URL, {
				method: "POST",
				headers: {
					...this.getBaseHeaders(),
					"content-type": "application/x-www-form-urlencoded",
					referer: "https://x.com/compose/post",
				},
				body: params.toString(),
			});
			if (!res.ok) {
				const text = await res.text();
				return { success: false, error: `fallback HTTP ${res.status}: ${text.slice(0, 200)}` };
			}
			const data = (await res.json()) as {
				id_str?: string;
				id?: number | string;
				errors?: Array<{ code?: number; message?: string }>;
			};
			if (data.errors && data.errors.length > 0) {
				return { success: false, error: this.formatErrors(data.errors) };
			}
			const tweetId = data.id_str ?? (data.id !== undefined ? String(data.id) : undefined);
			if (tweetId) {
				return { success: true, tweetId, url: `https://x.com/i/web/status/${tweetId}` };
			}
			return { success: false, error: "fallback: no id returned" };
		} catch (err) {
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	private async maybeFallbackOnErrors(
		errors: Array<{ code?: number; message?: string }>,
		variables: Record<string, unknown>,
	): Promise<XPostResult | null> {
		if (!errors.some((e) => e.code === 226)) return null;
		return this.postStatusUpdateFallback(variables);
	}

	private async query(
		queryId: string,
		operationName: string,
		variables: Record<string, unknown>,
	): Promise<{ data?: unknown; errors?: Array<{ message?: string }> }> {
		// X's GraphQL surface accepts POST for both queries and mutations, and
		// some operations (notably SearchTimeline) only respond to POST — they
		// 404 the equivalent GET. So we POST everything for consistency.
		const url = `${GQL_BASE}/${queryId}/${operationName}`;
		const body = JSON.stringify({ variables, features: buildFeatures(), queryId });
		const res = await this.fetchWithTimeout(url, {
			method: "POST",
			headers: this.getJsonHeaders(),
			body,
		});
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`${operationName} HTTP ${res.status}: ${text.slice(0, 200)}`);
		}
		const json = (await res.json()) as { data?: unknown; errors?: Array<{ message?: string }> };
		if (json.errors && json.errors.length > 0) {
			throw new Error(`${operationName}: ${json.errors.map((e) => e.message ?? "?").join(", ")}`);
		}
		return json;
	}

	private async mutation(
		queryId: string,
		operationName: string,
		variables: Record<string, unknown>,
		predicate: (body: { data?: unknown }) => boolean,
	): Promise<{ success: boolean; error?: string }> {
		const result = await this.mutationRaw(queryId, operationName, variables);
		if (!result.ok) return { success: false, error: result.error };
		const ok = predicate(result.body);
		return ok ? { success: true } : { success: false, error: `${operationName} acknowledged but predicate failed` };
	}

	private async mutationRaw(
		queryId: string,
		operationName: string,
		variables: Record<string, unknown>,
	): Promise<{ ok: true; body: { data?: unknown } } | { ok: false; error: string }> {
		const url = `${GQL_BASE}/${queryId}/${operationName}`;
		const body = JSON.stringify({ variables, queryId });
		try {
			const res = await this.fetchWithTimeout(url, {
				method: "POST",
				headers: { ...this.getJsonHeaders(), referer: "https://x.com/" },
				body,
			});
			if (!res.ok) {
				const text = await res.text();
				return { ok: false, error: `${operationName} HTTP ${res.status}: ${text.slice(0, 200)}` };
			}
			const data = (await res.json()) as {
				data?: unknown;
				errors?: Array<{ code?: number; message?: string }>;
			};
			if (data.errors && data.errors.length > 0) {
				return { ok: false, error: this.formatErrors(data.errors) };
			}
			return { ok: true, body: data };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	private async restMutation(
		url: string,
		params: URLSearchParams,
	): Promise<{ success: boolean; error?: string }> {
		try {
			const res = await this.fetchWithTimeout(url, {
				method: "POST",
				headers: {
					...this.getBaseHeaders(),
					"content-type": "application/x-www-form-urlencoded",
					referer: "https://x.com/",
				},
				body: params.toString(),
			});
			if (!res.ok) {
				const text = await res.text();
				return { success: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
			}
			return { success: true };
		} catch (err) {
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	private formatErrors(errors: Array<{ code?: number; message?: string }>): string {
		return errors
			.map((e) => (typeof e.code === "number" ? `${e.message ?? "?"} (${e.code})` : e.message ?? "?"))
			.join(", ");
	}

	private getBaseHeaders(): Record<string, string> {
		// `x-client-transaction-id` intentionally omitted: X validates this header
		// against a signed challenge baked into the live web bundle, and a
		// fake/random value triggers a silent 200 with empty `create_tweet` data
		// (the post never lands). Omitting the header makes X treat us like a
		// non-web client and process the request normally.
		return {
			accept: "*/*",
			"accept-language": "en-US,en;q=0.9",
			authorization: X_PUBLIC_BEARER,
			"x-csrf-token": this.ct0,
			"x-twitter-auth-type": "OAuth2Session",
			"x-twitter-active-user": "yes",
			"x-twitter-client-language": "en",
			"x-client-uuid": this.clientUuid,
			"x-twitter-client-deviceid": this.clientDeviceId,
			cookie: this.cookieHeader,
			"user-agent": this.userAgent,
			origin: "https://x.com",
			referer: "https://x.com/",
		};
	}

	private getJsonHeaders(): Record<string, string> {
		return { ...this.getBaseHeaders(), "content-type": "application/json" };
	}

	private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
		if (!this.timeoutMs || this.timeoutMs <= 0) return fetch(url, init);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			return await fetch(url, { ...init, signal: controller.signal });
		} finally {
			clearTimeout(timer);
		}
	}
}

// ── Helpers (response shape extraction) ─────────────────────────────────────

interface ViewerUserResult {
	__typename?: string;
	rest_id?: string;
	legacy?: {
		screen_name?: string;
		name?: string;
		description?: string;
		followers_count?: number;
		friends_count?: number;
		verified?: boolean;
	};
	core?: { screen_name?: string; name?: string };
}

function summarizeUser(u: ViewerUserResult): XUserSummary {
	const screenName = u.legacy?.screen_name ?? u.core?.screen_name ?? "";
	const name = u.legacy?.name ?? u.core?.name;
	return {
		userId: u.rest_id ?? "",
		screenName,
		...(name !== undefined ? { name } : {}),
		...(u.legacy?.description !== undefined ? { description: u.legacy.description } : {}),
		...(u.legacy?.followers_count !== undefined ? { followersCount: u.legacy.followers_count } : {}),
		...(u.legacy?.friends_count !== undefined ? { followingCount: u.legacy.friends_count } : {}),
		...(u.legacy?.verified !== undefined ? { verified: u.legacy.verified } : {}),
	};
}

function collectTweets(data: { data?: unknown }): XTweetSummary[] {
	const out: XTweetSummary[] = [];
	walk(data, (node) => {
		if (typeof node !== "object" || node === null) return;
		const obj = node as Record<string, unknown>;
		const legacy = obj.legacy as Record<string, unknown> | undefined;
		if (!legacy || typeof legacy.full_text !== "string") return;
		const tweetId = (obj.rest_id as string) || (legacy.id_str as string);
		if (!tweetId) return;
		const userResults =
			(obj.core as { user_results?: { result?: ViewerUserResult } } | undefined)?.user_results
				?.result ?? undefined;
		out.push({
			tweetId,
			text: legacy.full_text as string,
			authorId: (legacy.user_id_str as string) || userResults?.rest_id,
			authorScreenName: userResults?.legacy?.screen_name ?? userResults?.core?.screen_name,
			createdAt: legacy.created_at as string | undefined,
			favoriteCount: legacy.favorite_count as number | undefined,
			retweetCount: legacy.retweet_count as number | undefined,
			replyCount: legacy.reply_count as number | undefined,
			url: `https://x.com/i/web/status/${tweetId}`,
		});
	});
	const seen = new Set<string>();
	return out.filter((t) => (seen.has(t.tweetId) ? false : seen.add(t.tweetId)));
}

interface RawNotificationsResponse {
	globalObjects?: {
		notifications?: Record<string, RawNotification>;
		tweets?: Record<string, { id_str?: string }>;
		users?: Record<string, { id_str?: string; screen_name?: string }>;
	};
}

interface RawNotification {
	id?: string;
	timestampMs?: string;
	message?: { text?: string };
	template?: {
		aggregateUserActionsV1?: {
			targetObjects?: Array<{ tweet?: { id?: string } }>;
			fromUsers?: Array<{ user?: { id?: string } }>;
		};
	};
	icon?: { id?: string };
}

function collectNotifications(body: RawNotificationsResponse): XNotification[] {
	const notifs = body.globalObjects?.notifications ?? {};
	const users = body.globalObjects?.users ?? {};
	const out: XNotification[] = [];
	for (const [id, n] of Object.entries(notifs)) {
		const targetTweet =
			n.template?.aggregateUserActionsV1?.targetObjects?.[0]?.tweet?.id ?? undefined;
		const fromUserId = n.template?.aggregateUserActionsV1?.fromUsers?.[0]?.user?.id ?? undefined;
		const fromUser = fromUserId ? users[fromUserId] : undefined;
		out.push({
			id,
			timestamp: n.timestampMs ?? "",
			message: n.message?.text,
			...(targetTweet ? { tweetId: targetTweet } : {}),
			...(fromUser?.screen_name ? { fromUserScreenName: fromUser.screen_name } : {}),
			kind: classifyNotification(n.icon?.id ?? n.message?.text ?? ""),
		});
	}
	return out.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
}

function classifyNotification(hint: string): XNotification["kind"] {
	const h = hint.toLowerCase();
	if (h.includes("heart")) return "like";
	if (h.includes("retweet")) return "retweet";
	if (h.includes("person") || h.includes("follow")) return "follow";
	if (h.includes("reply") || h.includes("replied")) return "reply";
	if (h.includes("mention") || h.includes("@")) return "mention";
	return "other";
}

function walk(node: unknown, visit: (n: unknown) => void): void {
	if (node === null || node === undefined) return;
	visit(node);
	if (Array.isArray(node)) {
		for (const item of node) walk(item, visit);
		return;
	}
	if (typeof node === "object") {
		for (const v of Object.values(node)) walk(v, visit);
	}
}
