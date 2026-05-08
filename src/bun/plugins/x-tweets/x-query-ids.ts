/**
 * GraphQL operation IDs from x.com's web client.
 *
 * X rotates these every few months as it ships new bundle versions. When an
 * action starts returning HTTP 404 or "operation not found", refresh by
 * re-extracting from the live bundle:
 *
 *   curl -sS https://x.com/home -H "user-agent: Mozilla/5.0 ..." \
 *     | grep -oE 'main\.[a-z0-9]+\.js' | head -1
 *   # then download that file and:
 *   grep -oE 'queryId:"[^"]+",operationName:"[^"]+"' main.<hash>.js | sort -u
 *
 * Last refreshed: 2026-05-05 against main.0d6e4b3a.js.
 *
 * The featureSwitches metadata travels alongside each operation in the bundle.
 * For mutations (FavoriteTweet, CreateRetweet, DeleteTweet, etc.) the bundle
 * declares `featureSwitches:[]` — those operations don't need a `features`
 * payload at all. For queries we ship the kitchen-sink features object below
 * which is a strict superset of every operation's switches; X ignores extras.
 */

export const X_QUERY_IDS = {
	// — Mutations (write actions; no features payload) —
	CreateTweet: "uKLMT1QYb6HJah_Cp5euiQ",
	DeleteTweet: "nxpZCY2K-I6QoFHAHeojFQ",
	FavoriteTweet: "lI07N6Otwv1PhnEgXILM7A",
	UnfavoriteTweet: "ZYKSe-w7KEslx3JhSIk5LA",
	CreateRetweet: "mbRO74GrOvSfRcJnlMapnQ",
	DeleteRetweet: "ZyZigVsNiFO6v1dEks1eWg",
	CreateBookmark: "aoDbu3RHznuiSkQ9aNM67Q",
	DeleteBookmark: "Wlmlj2-xzyS1GN3a6cj-mQ",

	// — Queries (read actions; need features payload) —
	Viewer: "_8ClT24oZ8tpylf_OSuNdg",
	UserByScreenName: "IGgvgiOx4QZndDHuD3x9TQ",
	UserByRestId: "VQfQ9wwYdk6j_u2O4vt64Q",
	UserTweets: "pQHADmT91zIY83UbK0x4Lw",
	UserTweetsAndReplies: "6eh3huj6fJnA3Naupj4w0Q",
	TweetDetail: "UyruM32D2wFB3iSrtf_JcQ",
	SearchTimeline: "xrS3h-srT2mQT-g3lKsUjA",
	HomeLatestTimeline: "e89k_Hjy9W-HblqrtNCrlQ",
	HomeTimeline: "kUbOYB721bLdKYy6pQdBWQ",
	Following: "BdLNz9uyjufSJAveij_WZw",
	Followers: "f_mHnjGiLxcNKbvKG5VQZg",
	Likes: "Q69CuyHDCvTaFX95D5Zc8w",
	UserMedia: "rfcApxVNsBOsann7TAegWA",
} as const;

/**
 * Kitchen-sink feature flags. Strict superset of every X query operation's
 * `featureSwitches` list — X ignores extras, so one object works for all.
 */
export function buildFeatures(): Record<string, boolean> {
	return {
		// CreateTweet + most mutation/query feature flags
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
		// Viewer + UserByScreenName extras
		subscriptions_upsells_api_enabled: true,
		hidden_profile_subscriptions_enabled: true,
		subscriptions_verification_info_is_identity_verified_enabled: true,
		subscriptions_verification_info_verified_since_enabled: true,
		highlights_tweets_tab_ui_enabled: true,
		responsive_web_twitter_article_notes_tab_enabled: true,
		subscriptions_feature_can_gift_premium: true,
		responsive_web_graphql_exclude_directive_enabled: true,
		// SearchTimeline / TweetDetail extras
		rweb_cashtags_enabled: true,
	};
}

/** Public X web bearer (same constant the official x.com bundle uses). */
export const X_PUBLIC_BEARER =
	"Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
