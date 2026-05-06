/**
 * Minimal X (Twitter) client for posting + replying as the logged-in user.
 *
 * TypeScript port of the relevant bits of `@steipete/bird` (MIT) — specifically
 * the `tweet()` / `reply()` flow that talks to X's undocumented web GraphQL
 * `CreateTweet` endpoint with cookie auth (`auth_token` + `ct0`).
 *
 * Auth model: same as the X web app. The user signs into x.com in their
 * browser, exports the `auth_token` and `ct0` cookies (Cookie-Editor extension
 * is the standard recipe), and pastes them into the vault. No API key, no
 * developer account — everything routes through the same GraphQL surface
 * the official x.com web client uses.
 *
 * **Heads up**: X's GraphQL API is undocumented and the operation hash
 * (`queryId`) rotates from time to time. If posting starts 404'ing, refresh
 * the QUERY_ID below from a current build of the bird CLI:
 *
 *     bunx @steipete/bird query-ids --fresh --json | jq -r '.CreateTweet'
 *
 * The fallback path uses the legacy v1.1 `/i/api/1.1/statuses/update.json`
 * endpoint (which has been stable for ~15 years) for resilience.
 */

const TWITTER_API_BASE = "https://x.com/i/api/graphql";
const TWITTER_STATUS_UPDATE_URL = "https://x.com/i/api/1.1/statuses/update.json";

// The CreateTweet operation hash. Refresh from `bird query-ids --fresh` if
// posting stops working — X rotates these every few months.
const CREATE_TWEET_QUERY_ID = "TAJw1rBsjAtdNgTdlo2oeg";

// Public bearer token used by every browser X session. NOT a developer key —
// this is hard-coded into the x.com web bundle. Same value bird uses; same
// value the official site uses. If X rotates it the symptom is HTTP 401 on
// every request and we can pull the new one from a network capture.
const X_PUBLIC_BEARER =
	"Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

// The features object that has to ship with every CreateTweet call. X uses
// these to decide which interactive UI surfaces are enabled in the response
// (longform tweets, grok, edit, etc.). Wrong/missing features → 400.
function buildTweetCreateFeatures(): Record<string, boolean> {
	return {
		rweb_video_screen_enabled: true,
		creator_subscriptions_tweet_preview_api_enabled: true,
		premium_content_api_read_enabled: false,
		communities_web_enable_tweet_community_results_fetch: true,
		c9s_tweet_anatomy_moderator_badge_enabled: true,
		responsive_web_grok_analyze_button_fetch_trends_enabled: false,
		responsive_web_grok_analyze_post_followups_enabled: false,
		responsive_web_grok_annotations_enabled: false,
		responsive_web_jetfuel_frame: true,
		post_ctas_fetch_enabled: true,
		responsive_web_grok_share_attachment_enabled: true,
		responsive_web_edit_tweet_api_enabled: true,
		graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
		view_counts_everywhere_api_enabled: true,
		longform_notetweets_consumption_enabled: true,
		responsive_web_twitter_article_tweet_consumption_enabled: true,
		tweet_awards_web_tipping_enabled: false,
		responsive_web_grok_show_grok_translated_post: false,
		responsive_web_grok_analysis_button_from_backend: true,
		creator_subscriptions_quote_tweet_preview_enabled: false,
		longform_notetweets_rich_text_read_enabled: true,
		longform_notetweets_inline_media_enabled: true,
		profile_label_improvements_pcf_label_in_post_enabled: true,
		responsive_web_profile_redirect_enabled: false,
		rweb_tipjar_consumption_enabled: true,
		verified_phone_label_enabled: false,
		articles_preview_enabled: true,
		responsive_web_grok_community_note_auto_translation_is_enabled: false,
		responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
		freedom_of_speech_not_reach_fetch_enabled: true,
		standardized_nudges_misinfo: true,
		tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
		responsive_web_grok_image_annotation_enabled: true,
		responsive_web_grok_imagine_annotation_enabled: true,
		responsive_web_graphql_timeline_navigation_enabled: true,
		responsive_web_enhance_cards_enabled: false,
	};
}

export interface XCookies {
	authToken: string;
	ct0: string;
}

export interface XPostResult {
	success: boolean;
	tweetId?: string;
	url?: string;
	error?: string;
}

export interface XClientOptions {
	cookies: XCookies;
	timeoutMs?: number;
	userAgent?: string;
}

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

	/** Post a new tweet. Returns `{success, tweetId, url}` or `{success:false, error}`. */
	async tweet(text: string): Promise<XPostResult> {
		return this.createTweet({
			tweet_text: text,
			dark_request: false,
			media: { media_entities: [], possibly_sensitive: false },
			semantic_annotation_ids: [],
		});
	}

	/** Reply to an existing tweet by ID. */
	async reply(text: string, replyToTweetId: string): Promise<XPostResult> {
		return this.createTweet({
			tweet_text: text,
			reply: {
				in_reply_to_tweet_id: replyToTweetId,
				exclude_reply_user_ids: [],
			},
			dark_request: false,
			media: { media_entities: [], possibly_sensitive: false },
			semantic_annotation_ids: [],
		});
	}

	/** Quick auth check — returns the logged-in user's screen_name or throws. */
	async whoami(): Promise<{ screenName: string; userId?: string }> {
		const url = "https://api.x.com/1.1/account/settings.json";
		const res = await this.fetchWithTimeout(url, {
			method: "GET",
			headers: this.getBaseHeaders(),
		});
		if (!res.ok) {
			throw new Error(`whoami HTTP ${res.status}`);
		}
		const body = (await res.json()) as { screen_name?: string };
		if (!body.screen_name) throw new Error("whoami response missing screen_name");
		return { screenName: body.screen_name };
	}

	private async createTweet(variables: Record<string, unknown>): Promise<XPostResult> {
		const features = buildTweetCreateFeatures();
		const queryId = CREATE_TWEET_QUERY_ID;
		const url = `${TWITTER_API_BASE}/${queryId}/CreateTweet`;
		const body = JSON.stringify({ variables, features, queryId });
		const headers = {
			...this.getJsonHeaders(),
			referer: "https://x.com/compose/post",
		};

		try {
			const response = await this.fetchWithTimeout(url, { method: "POST", headers, body });
			if (response.status === 404) {
				// X probably rotated the queryId. Fall back to the v1.1 status_update
				// endpoint which has been stable for ~15 years.
				return this.postStatusUpdateFallback(variables);
			}
			if (!response.ok) {
				const text = await response.text();
				return { success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
			}
			const data = (await response.json()) as {
				errors?: Array<{ code?: number; message?: string }>;
				data?: { create_tweet?: { tweet_results?: { result?: { rest_id?: string } } } };
			};
			if (data.errors && data.errors.length > 0) {
				const fallback = await this.maybeFallbackOnErrors(data.errors, variables);
				if (fallback) return fallback;
				return { success: false, error: this.formatErrors(data.errors) };
			}
			const tweetId = data.data?.create_tweet?.tweet_results?.result?.rest_id;
			if (tweetId) {
				return {
					success: true,
					tweetId,
					url: `https://x.com/i/web/status/${tweetId}`,
				};
			}
			return { success: false, error: "Tweet created but no ID returned" };
		} catch (err) {
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	/**
	 * v1.1 fallback. X returns error code 226 when the GraphQL surface refuses
	 * a tweet for spam-prevention reasons but the same content is fine via the
	 * legacy endpoint. Also useful when the queryId rotates and we can't reach
	 * GraphQL at all.
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
		// 226 = "Tweet appears to be automated"; sometimes the v1.1 endpoint accepts.
		if (!errors.some((e) => e.code === 226)) return null;
		return this.postStatusUpdateFallback(variables);
	}

	private formatErrors(errors: Array<{ code?: number; message?: string }>): string {
		return errors
			.map((e) => (typeof e.code === "number" ? `${e.message ?? "?"} (${e.code})` : e.message ?? "?"))
			.join(", ");
	}

	private getBaseHeaders(): Record<string, string> {
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
			"x-client-transaction-id": this.randomTransactionId(),
			cookie: this.cookieHeader,
			"user-agent": this.userAgent,
			origin: "https://x.com",
			referer: "https://x.com/",
		};
	}

	private getJsonHeaders(): Record<string, string> {
		return { ...this.getBaseHeaders(), "content-type": "application/json" };
	}

	private randomTransactionId(): string {
		const buf = new Uint8Array(16);
		crypto.getRandomValues(buf);
		return Array.from(buf)
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
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
