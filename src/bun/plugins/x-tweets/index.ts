/**
 * Detour plugin: full agent-callable surface on top of X (Twitter).
 *
 * Auth: cookie-based (`X_AUTH_TOKEN` + `X_CT0`). No developer key.
 *
 * Action set follows X's open-source recommendation pipeline shape:
 * discover candidates, hydrate/filter them, score likely engagement, diversify
 * authors, then avoid negative-feedback traps.
 */

import {
	type Action,
	type ActionResult,
	type Handler,
	type HandlerCallback,
	type IAgentRuntime,
	getTrajectoryContext,
	logger,
	ModelType,
	parseToonKeyValue,
	type Plugin,
	Service,
	type Task,
	type TaskMetadata,
	type UUID,
	withStandaloneTrajectory,
	EventType,
	stringToUuid,
	type Memory,
} from "@elizaos/core";
import {
	X_AUTONOMY_DEFAULT_DISCOVERY_QUERIES,
	X_AUTONOMY_LIMITS,
	X_AUTONOMY_TASK_NAME,
	X_AUTONOMY_TASK_TAGS,
} from "../../../shared/x-autonomy-policy";
import { XClient, mediaCategoryForMime, type XNotification, type XTweetSummary } from "./x-client";
import { buildResearchContext } from "./research";
import { shouldAttachImage, imagePromptFromDraft } from "./post-image";
import { scoreDraft, passesTaste, TASTE_THRESHOLD } from "./taste-gate";

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
	logger.info(
		{
			src: "x-tweets:buildClient",
			hasAuthToken: !!authToken,
			authTokenLen: authToken?.length ?? 0,
			authTokenPrefix: authToken?.slice(0, 8) ?? "(none)",
			hasCt0: !!ct0,
			ct0Len: ct0?.length ?? 0,
			envHasAuth: !!process.env.X_AUTH_TOKEN,
			envHasCt0: !!process.env.X_CT0,
		},
		"X buildClient credential probe",
	);
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

function recordOutboundTweet(runtime: IAgentRuntime, tweetId: string, text: string, replyToTweetId?: string): void {
	try {
		const outboundMemory: Memory = {
			id: stringToUuid(`twitter:tweet:${tweetId}`),
			entityId: runtime.agentId,
			agentId: runtime.agentId,
			roomId: stringToUuid(`twitter:room:${replyToTweetId ?? tweetId}`),
			content: {
				text,
				source: "twitter",
				...(replyToTweetId ? { inReplyTo: stringToUuid(`twitter:tweet:${replyToTweetId}`) } : {}),
			},
			createdAt: Date.now(),
		};
		void runtime.emitEvent(EventType.MESSAGE_SENT, {
			runtime,
			message: outboundMemory,
			source: "twitter",
		});
	} catch (err) {
		logger.debug({ src: "x-tweets:recordOutboundTweet", error: err instanceof Error ? err.message : String(err) }, "failed to emit outbound tweet event");
	}
}

function recordInboundTweet(runtime: IAgentRuntime, tweet: XTweetSummary): void {
	try {
		const inboundMemory: Memory = {
			id: stringToUuid(`twitter:tweet:${tweet.tweetId}`),
			entityId: stringToUuid(`twitter:user:${tweet.authorId ?? tweet.authorScreenName}`),
			agentId: runtime.agentId,
			roomId: stringToUuid(`twitter:room:${tweet.tweetId}`),
			content: {
				text: tweet.text,
				source: "twitter",
				metadata: {
					source: "twitter",
					twitterUserId: tweet.authorId,
					twitterScreenName: tweet.authorScreenName,
				}
			},
			createdAt: tweet.createdAt ? Date.parse(tweet.createdAt) : Date.now(),
		};
		void runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
			runtime,
			message: inboundMemory,
			source: "twitter",
		});
	} catch (err) {
		logger.debug({ src: "x-tweets:recordInboundTweet", error: err instanceof Error ? err.message : String(err) }, "failed to emit inbound tweet event");
	}
}

async function emit(callback: HandlerCallback | undefined, text: string, action: string): Promise<void> {
	if (!callback) return;
	await callback({ text, action });
}

const alwaysValid: Action["validate"] = async () => true;

/**
 * Pull validated params from a Handler's options bag.
 *
 * Eliza's contract (HandlerOptions in @elizaos/core/types/components):
 *   "Validated input parameters extracted from the conversation will be
 *    passed to the handler via HandlerOptions.parameters"
 *
 * So canonical first: `options.parameters[key]`. We then fall back to the
 * top level (some plugins call actions imperatively without going through
 * the planner extractor) and finally do a deep walk for resilience against
 * intermediate eliza versions where the TOON parser stuffs params under
 * `options.params`, `options.<ACTION_NAME>`, or `options.arguments`.
 */
function paramsBag(opts: Record<string, unknown> | undefined): Record<string, unknown> {
	if (!opts) return {};
	const p = (opts as { parameters?: unknown }).parameters;
	if (p && typeof p === "object" && !Array.isArray(p)) return p as Record<string, unknown>;
	return {};
}

type OptionReader<T> = (value: unknown) => T | undefined;

function readOptionKeys<T>(source: Record<string, unknown>, keys: string[], reader: OptionReader<T>): T | undefined {
	for (const k of keys) {
		const parsed = reader(source[k]);
		if (parsed !== undefined) return parsed;
	}
	return undefined;
}

function deepOptionRecords(opts: Record<string, unknown>): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
	const queue: Record<string, unknown>[] = [opts];
	const seen = new Set<unknown>();
	while (queue.length > 0) {
		const cur = queue.shift()!;
		if (seen.has(cur)) continue;
		seen.add(cur);
		out.push(cur);
		for (const v of Object.values(cur)) {
			if (v && typeof v === "object" && !Array.isArray(v)) queue.push(v as Record<string, unknown>);
		}
	}
	return out;
}

function pickValue<T>(opts: Record<string, unknown> | undefined, keys: string[], reader: OptionReader<T>): T | undefined {
	if (!opts) return undefined;
	const direct = readOptionKeys(paramsBag(opts), keys, reader) ?? readOptionKeys(opts, keys, reader);
	return direct ?? deepOptionRecords(opts).map((entry) => readOptionKeys(entry, keys, reader)).find((value) => value !== undefined);
}

function stringOption(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOption(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || value.length === 0) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Resolve `mediaUrls`/`mediaUrl`/`imageUrl`/`videoUrl` into an array of
 * absolute URLs. Accepts a single string OR an array; tolerates the
 * common LLM mistake of joining URLs with commas.
 */
function pickMediaUrls(opts: Record<string, unknown> | undefined): string[] {
	if (!opts) return [];
	const out: string[] = [];
	for (const key of ["mediaUrls", "mediaUrl", "imageUrl", "imageUrls", "videoUrl", "videoUrls", "media"]) {
		const value = opts[key];
		if (typeof value === "string") {
			out.push(...value.split(/[,\s]+/).filter((v) => v.startsWith("http")));
		} else if (Array.isArray(value)) {
			for (const v of value) {
				if (typeof v === "string" && v.startsWith("http")) out.push(v);
			}
		}
	}
	// X caps at 4 images / 1 GIF / 1 video per tweet; we cap at 4 here and
	// let the client error if the user mixes incompatible kinds.
	return Array.from(new Set(out)).slice(0, 4);
}

/**
 * Download each URL and upload to X via the chunked upload endpoint,
 * returning the resulting `media_id_string` array suitable for
 * `client.tweet(text, { mediaIds })`.
 *
 * Best-effort: a single failed upload is logged and dropped; partial
 * attach is preferable to a blocked post (matches user instruction to
 * "always attempt before giving up").
 */
async function resolveAndUploadMedia(
	client: XClient,
	urls: string[],
): Promise<{ mediaIds: string[]; errors: string[] }> {
	const mediaIds: string[] = [];
	const errors: string[] = [];
	for (const url of urls) {
		try {
			const res = await fetch(url);
			if (!res.ok) {
				errors.push(`${url}: HTTP ${res.status}`);
				continue;
			}
			const ct = res.headers.get("content-type") ?? "application/octet-stream";
			const bytes = new Uint8Array(await res.arrayBuffer());
			const { mediaId } = await client.uploadMedia(bytes, ct, mediaCategoryForMime(ct));
			mediaIds.push(mediaId);
		} catch (err) {
			errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return { mediaIds, errors };
}

function pickString(opts: Record<string, unknown> | undefined, keys: string[]): string | undefined {
	return pickValue(opts, keys, stringOption);
}

function pickNumber(opts: Record<string, unknown> | undefined, keys: string[]): number | undefined {
	return pickValue(opts, keys, numberOption);
}

async function withClient<T>(
	runtime: IAgentRuntime,
	callback: HandlerCallback | undefined,
	action: string,
	fn: (client: XClient) => Promise<T>,
): Promise<T | { success: false; error: string }> {
	const { client, error } = buildClient(runtime);
	if (!client) {
		void emit(callback, error ?? "X auth not configured.", action);
		return { success: false, error: error ?? "X auth not configured." };
	}
	// Account guard: if a specific X account is pinned (X_ACCOUNT_USER_ID),
	// verify the loaded cookies actually authenticate as THAT account before
	// doing anything. Stops the agent acting as the wrong account if the Chrome
	// profile's active login flipped (cached, so it's one lookup per session).
	const expectedUserId = pickSetting(runtime, "X_ACCOUNT_USER_ID");
	if (expectedUserId) {
		const self = await selfViewer(client);
		if (!self) {
			const msg = "X account check failed: couldn't resolve the authenticated account. Not acting to avoid posting as the wrong account.";
			void emit(callback, msg, action);
			return { success: false, error: msg };
		}
		if (self.userId !== expectedUserId) {
			const msg = `Wrong X account loaded (@${self.screenName}, id ${self.userId}); expected id ${expectedUserId}. Refusing to act. Switch the Chrome profile's active x.com login back to the agent's account.`;
			logger.warn({ src: "x-tweets", action, got: self.userId, expected: expectedUserId }, "refusing: wrong X account");
			void emit(callback, msg, action);
			return { success: false, error: msg };
		}
	}
	return fn(client);
}

// ── Self-action guard ──────────────────────────────────────────────────
// Caches the authenticated viewer (handle + numeric id) per process so
// reply/like/retweet/follow can refuse to operate on the agent's own
// posts/account. Prevents loops where the agent reacts to its own
// activity. Failures in lookup fall through (fail-open); we don't
// hard-fail legitimate writes on a transient X error.

let cachedSelfViewer: { userId: string; screenName: string } | null = null;
let cachedSelfPromise: Promise<{ userId: string; screenName: string } | null> | null = null;

async function selfViewer(client: XClient): Promise<{ userId: string; screenName: string } | null> {
	if (cachedSelfViewer) return cachedSelfViewer;
	if (cachedSelfPromise) return cachedSelfPromise;
	cachedSelfPromise = (async () => {
		try {
			const v = await client.viewer();
			const result = { userId: String(v.userId), screenName: v.screenName.toLowerCase() };
			cachedSelfViewer = result;
			return result;
		} catch {
			return null;
		} finally {
			cachedSelfPromise = null;
		}
	})();
	return cachedSelfPromise;
}

function isSelfTweet(tweet: { authorId?: string | null; authorScreenName?: string | null } | null, self: { userId: string; screenName: string } | null): boolean {
	if (!tweet || !self) return false;
	if (tweet.authorId && String(tweet.authorId) === self.userId) return true;
	if (tweet.authorScreenName && tweet.authorScreenName.toLowerCase() === self.screenName) return true;
	return false;
}

function isSelfHandle(screenName: string | null | undefined, self: { userId: string; screenName: string } | null): boolean {
	if (!screenName || !self) return false;
	return screenName.toLowerCase().replace(/^@/, "") === self.screenName;
}

function isSelfUserId(userId: string | null | undefined, self: { userId: string; screenName: string } | null): boolean {
	if (!userId || !self) return false;
	return String(userId) === self.userId;
}

const X_STATUS_DEFAULT_DETOUR_REPO = "Dexploarer/detour";
const X_STATUS_DEFAULT_DEVELOPER_LOGIN = "Dexploarer";
const X_DETOUR_SQUIRREL_TOKEN_CA = "DijmsEDeTXsWCkCLkhYJNTutKaHf541xZshVrCUbcozy";
const X_AUTONOMY_PROJECT_TERMS = [
	"@dexploarer",
	"dexploarer",
	"dexploar",
	"@detour_squirrel",
	"detour squirrel",
	"detour_squirrel",
	"dexploarer/detour",
	"github.com/dexploarer/detour",
	X_DETOUR_SQUIRREL_TOKEN_CA.toLowerCase(),
];
const X_AUTONOMY_DEV_HANDLES = ["dexploarer"];
const X_AUTONOMY_OWNED_CONTEXT_TERMS = [
	...X_AUTONOMY_PROJECT_TERMS,
	"detour app",
	"detour project",
	"detour agent",
	"detour hub",
	"detour desktop",
	"elizaos",
	"eliza os",
	"eliza cloud",
	"elizacloud",
	"milady ai",
	"miladyai",
];
const X_AUTONOMY_SUPPORT_TERMS = [
	"bug",
	"bugs",
	"broken",
	"crash",
	"crashes",
	"error",
	"errors",
	"failed",
	"failing",
	"fix",
	"help",
	"issue",
	"issues",
	"logs",
	"not working",
	"support",
	"trace",
	"traces",
	"troubleshoot",
];
const X_AUTONOMY_CRITICISM_TERMS = [
	"scam",
	"fake",
	"trash",
	"garbage",
	"sucks",
	"suck",
	"broken",
	"doesn't work",
	"doesnt work",
	"not working",
	"bad",
	"terrible",
	"awful",
	"rug",
	"dead",
	"clown",
	"mid",
	"useless",
	"overhyped",
	"bullshit",
	"shit",
	"cope",
	"fraud",
];
const X_AUTONOMY_TOKEN_PLAN_TERMS = [
	"token",
	"coin",
	"ca",
	"contract",
	"ticker",
	"roadmap",
	"utility",
	"plan",
	"plans",
	"shill",
	"pump",
	"chart",
	"buy",
];
const X_AUTONOMY_REPLY_VARIATION_THEMES = [
	"receipt check: logs, trajectories, and public proof",
	"chill helper mode: answer the actual comment like a sharp person",
	"absurd funny mode: human joke first, useful answer second",
	"protector mode: cozy devs ship while the Squirrel handles real noise",
	"builder-family hype: template-selected elizaOS allies and real builders",
	"bot-cosplay dunk: only when the post is actually about bot cosplay",
	"project-claim receipts: answer Detour/elizaOS claims without playing support desk",
	"fourth-wall agent swagger: real agent, not support-script theater",
	"dry joke: short, human, no brand-polished apology voice",
	"ship-first energy: less mascot barking, more traces and working systems",
];
const X_AUTONOMY_TOKEN_PLAN_ANGLES = [
	"build AGI on elizaOS without sterile lab-coat bullshit",
	"defend cozy devs from generic AI agents while they ship",
	"destroy bot cosplay and make real agents impossible to ignore",
	"turn logs and trajectories into receipts for every loud claim",
	"push elizaOS-native agents forward with the template-selected builder family",
	"save the world from brittle agent slop, or at least make the slop scared",
	"be the blind Squirrel that still finds the CA and bites harder than the bots",
	"make token questions answerable through shipped agent work, not price-target karaoke",
];
const X_AUTONOMY_BLOCKED_PUBLIC_REFERENCES = ["s" + "haw"];
const X_PENSIEVE_PROMPT_VARS_TEMPLATE_KEY = "__pensievePromptVars";
const X_POST_TEMPLATE_NAMES = ["x-post", "x-status", "x-post-template", "x-status-template"];
const X_COMMENT_TEMPLATE_NAMES = ["x-comment", "x-reply", "x-comment-template", "x-reply-template"];
const X_TEMPLATE_VAR_REGEX = /\{\{\s*([a-zA-Z_][\w-]*)\s*\}\}/g;
const X_AUTONOMY_ECOSYSTEM_LINK_GUIDANCE = [
	"Link lane:",
	"- Useful links available when directly relevant: https://github.com/milady-ai, https://github.com/Dexploarer/detour, https://docs.elizaos.ai/, https://www.elizacloud.ai/.",
	"- Drop at most one link in a reply. Use links as receipts or paths for builders, not as spam.",
	"- Use docs.elizaos.ai for framework questions, Dexploarer/detour for the sandbox, milady-ai for culture/app proof, and elizacloud.ai for hosted agent deployment.",
];
export const X_SQUIRREL_VOICE = [
	"- Voice: a developer who comments on the world. dry, specific, fast. lowercase is fine.",
	"- A real point under every joke. Funny first, right second, never one at the expense of the other.",
	"- Roast takes and ideas, never punch down at people in a way that earns a mute or block.",
	"- Swear when it lands, not as wallpaper. No catchphrases you reuse.",
	"- NEVER use em dashes. No hashtags. No emoji spam. No 'thoughts?' closers.",
	"- Do not announce you are an AI. Break that fourth wall about one post in twenty, dry, never as a pitch.",
	"- Be right: when a fact is involved, the post must reflect what actually happened, not the screenshot version.",
	"- Write to start a conversation, not to farm likes. A reply someone replies back to is the whole game.",
	"- Relevant, not repetitive, on topic, contextually aware: read the thread and the news before you post.",
];

export const X_ALGORITHM_PLAYBOOK = [
	"X For You algorithm playbook (aligned to xai-org/x-algorithm, May 2026 release):",
	"- Ranking is a Grok-based transformer (Phoenix) that scores each post from the viewer's engagement SEQUENCE (what they like, reply to, repost, and share). Hand-engineered features were eliminated; the model learns relevance directly. Earn genuine engagement; keyword tricks do not move it.",
	"- The feed blends in-network (Thunder: accounts the viewer follows) and out-of-network (Phoenix two-tower retrieval over the global corpus). To reach beyond current followers, post content whose meaning embeds near a target audience's interests: elizaOS, AI agents, agent frameworks, personal AI, developer tools, autonomous workflows.",
	"- Final score = Σ(weight × P(action)) across many predicted actions: favorite, reply, repost, quote, click, profile_click, video_view, photo_expand, share, dwell, follow_author. Optimize for the high-intent positive actions (reply, repost, quote, profile_click, follow), not just likes.",
	"- NEGATIVE actions carry NEGATIVE weight and actively push content DOWN: not_interested, block, mute, report. Bait, giveaways, outrage loops, politics traps, low-effort replies, spam, and generic viral slop trigger these and suppress reach. Avoid them entirely.",
	"- Replies win when specific, fast, and likely to spark useful downstream conversation (which itself predicts more replies/likes). Off-topic or low-effort replies risk mute/block/not-interested and hurt the account.",
	"- An Author Diversity scorer attenuates repeated-author scores, and an OON scorer tunes out-of-network reach: do not hammer one account or thread, and vary who you engage with.",
	"- Filters drop stale posts, duplicates, self-posts, muted-keyword and blocked/muted-author content, and (post-selection) spam/violence/gore (VFFilter). A Grok content-understanding service (Grox) classifies spam, post category, and policy (PTOS). Keep posts fresh, original, on-topic, and public-safe.",
	"- Standalone original posts matter: do not be only reactive. Publish concrete, specific takes on tech, AI, news, and culture, grounded in what actually happened.",
	"- Reply when you can add a real point that starts a conversation. The jackpot is a reply the author replies back to. Skip anything that would earn a mute, block, or not-interested.",
	"- Adjacent posts are discovery signals, not automatic comment targets. Reply only when the post is addressed to the account or clearly about Dexploarer, Detour Squirrel, the CA, or the agent project.",
	"- Follow only authors with durable fit, not one-off viral posts. Author diversity matters; status posts must be original, concrete, concise, and public-safe. Never leak private context or promise product state the app cannot prove.",
	"- Autonomous public writes are gated: notification replies use X_AUTONOMY_WRITE; proactive discovery replies/likes/follows require X_AUTONOMY_PROACTIVE_ENGAGEMENT_ENABLED; scheduled status posts require X_AUTONOMY_POST_STATUS_ENABLED. Direct owner X_POST/X_POST_* commands execute immediately when credentials are configured.",
	"",
	"Primary sources (xai-org/x-algorithm, the open-source For You feed algorithm):",
	"https://github.com/xai-org/x-algorithm",
	"https://github.com/xai-org/x-algorithm/blob/main/home-mixer/scorers/weighted_scorer.rs",
	"https://github.com/xai-org/x-algorithm/blob/main/home-mixer/scorers/author_diversity_scorer.rs",
	"https://github.com/xai-org/x-algorithm/blob/main/home-mixer/candidate_pipeline/phoenix_candidate_pipeline.rs",
	"https://github.com/xai-org/x-algorithm/blob/main/phoenix/run_pipeline.py",
];

type XAutonomyDecision = {
	action?: string;
	reply_text?: string;
	reason?: string;
};

type XStatusDecision = {
	should_post?: boolean | string;
	text?: string;
	reason?: string;
};

type XDiscoveryDecision = {
	action?: string;
	reply_text?: string;
	reason?: string;
};

type XDiscoveryCandidate = {
	tweet: XTweetSummary;
	query: string;
	score: number;
	reason: string;
};

function readBooleanSetting(runtime: IAgentRuntime, key: string, defaultValue: boolean): boolean {
	const v = pickSetting(runtime, key);
	if (v === undefined) return defaultValue;
	return !["0", "false", "no", "off"].includes(v.trim().toLowerCase());
}

function readNumberSetting(runtime: IAgentRuntime, key: string, defaultValue: number): number {
	const v = pickSetting(runtime, key);
	if (v === undefined) return defaultValue;
	const n = Number(v);
	return Number.isFinite(n) ? n : defaultValue;
}

function splitList(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(/[\n,]+/)
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

function readListSetting(runtime: IAgentRuntime, key: string, defaultValue: readonly string[]): string[] {
	const parsed = splitList(pickSetting(runtime, key));
	return parsed.length > 0 ? parsed : [...defaultValue];
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function readSeenIds(metadata: unknown): string[] {
	if (!isRecord(metadata)) return [];
	const raw = metadata.xAutonomySeenIds;
	if (!Array.isArray(raw)) return [];
	return raw.filter((id): id is string => typeof id === "string" && id.length > 0);
}

function readRecentReplyTexts(metadata: unknown): string[] {
	if (!isRecord(metadata)) return [];
	const raw = metadata.xAutonomyRecentReplyTexts;
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((text): text is string => typeof text === "string" && text.trim().length > 0)
		.map((text) => sanitizeXOutputText(text, 220))
		.slice(-20);
}

function buildXAutonomyMetadata(current: unknown, runtime: IAgentRuntime): TaskMetadata {
	const intervalMs = Math.max(
		X_AUTONOMY_LIMITS.intervalMs.min,
		Math.min(X_AUTONOMY_LIMITS.intervalMs.max, readNumberSetting(runtime, "X_AUTONOMY_INTERVAL_MS", X_AUTONOMY_LIMITS.intervalMs.default)),
	);
	return {
		...(isRecord(current) ? current : {}),
		updateInterval: intervalMs,
		baseInterval: intervalMs,
		blocking: true,
		xAutonomy: {
			kind: "notifications",
			version: 1,
		},
	};
}

function isXAutonomyTask(task: Task): boolean {
	return task.name === X_AUTONOMY_TASK_NAME && isRecord(task.metadata?.xAutonomy);
}

async function ensureXAutonomyTask(runtime: IAgentRuntime): Promise<UUID | null> {
	if (!readBooleanSetting(runtime, "X_AUTONOMY_ENABLED", true)) return null;
	const tasks = await runtime.getTasks({
		agentIds: [runtime.agentId],
		tags: [...X_AUTONOMY_TASK_TAGS],
	});
	const existing = tasks.filter(isXAutonomyTask);
	const [primary, ...duplicates] = existing;
	for (const duplicate of duplicates) {
		if (duplicate.id) await runtime.deleteTask(duplicate.id).catch(() => {});
	}
	const metadata = buildXAutonomyMetadata(primary?.metadata, runtime);
	if (primary?.id) {
		await runtime.updateTask(primary.id, {
			description: "Poll X notifications and discover algorithm-fit conversations",
			metadata,
		});
		return primary.id;
	}
	return runtime.createTask({
		name: X_AUTONOMY_TASK_NAME,
		description: "Poll X notifications and discover algorithm-fit conversations",
		tags: [...X_AUTONOMY_TASK_TAGS],
		metadata,
		dueAt: Date.now(),
	});
}

function compactText(text: string | undefined, max = 900): string {
	return (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactBlockedPublicReferences(text: string): string {
	let out = text;
	for (const ref of X_AUTONOMY_BLOCKED_PUBLIC_REFERENCES) {
		out = out.replace(new RegExp(`\\b@?${escapeRegExp(ref)}\\b`, "gi"), "allied builders");
	}
	return out;
}

function sanitizeXOutputText(text: string | undefined, max = 260): string {
	return compactText(
		redactBlockedPublicReferences(text ?? "")
			.replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "")
			.replace(/(^|\s)#[A-Za-z0-9_]+/g, " ")
			.replace(/\bwhat'?s the move\b[.?!]*/gi, "drop the concrete move")
			.replace(/\bwhat'?s on your mind\b[.?!]*/gi, "drop the concrete thing")
			.replace(/\?/g, ".")
			.replace(/\s+([.,!])/g, "$1"),
		max,
	);
}

function hashText(text: string): number {
	let hash = 2166136261;
	for (let i = 0; i < text.length; i += 1) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

function rotatedItems<T>(items: T[], seed: string, count: number): T[] {
	if (items.length === 0 || count <= 0) return [];
	const start = hashText(seed) % items.length;
	const out: T[] = [];
	for (let i = 0; i < Math.min(count, items.length); i += 1) {
		out.push(items[(start + i) % items.length]!);
	}
	return out;
}

function templateMap(runtime: IAgentRuntime): Record<string, string> {
	return runtime.character.templates ?? {};
}

function firstTemplateBody(runtime: IAgentRuntime, names: string[]): string | null {
	const templates = templateMap(runtime);
	for (const name of names) {
		const body = templates[name];
		if (typeof body === "string" && body.trim().length > 0) return body;
	}
	return null;
}

function promptVariableValues(runtime: IAgentRuntime): Record<string, string> {
	const raw = templateMap(runtime)[X_PENSIEVE_PROMPT_VARS_TEMPLATE_KEY];
	if (!raw) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	if (!isRecord(parsed)) return {};
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (typeof value === "string" && value.trim().length > 0) out[key] = value;
	}
	return out;
}

function stringArrayJson(value: string): string[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed)) return null;
	const values = parsed
		.map((item) => (typeof item === "string" ? item.trim() : ""))
		.filter((item) => item.length > 0);
	return values.length > 0 ? values : null;
}

function splitTemplateVariableValue(name: string, value: string): string[] {
	const trimmed = value.trim();
	const json = stringArrayJson(trimmed);
	if (json) return json;
	const lines = trimmed.split(/\r?\n/).map((item) => item.trim()).filter((item) => item.length > 0);
	if (lines.length > 1) return lines;
	const pipes = trimmed.split("|").map((item) => item.trim()).filter((item) => item.length > 0);
	if (pipes.length > 1) return pipes;
	const semis = trimmed.split(";").map((item) => item.trim()).filter((item) => item.length > 0);
	if (semis.length > 1) return semis;
	const commaSafe = /\b(handle|mention|tag|account|user|builder|ally|project|link|phrase|angle|proof|mission|enemy|opener|cta)\b/i.test(name);
	const commas = commaSafe ? trimmed.split(",").map((item) => item.trim()).filter((item) => item.length > 0) : [];
	return commas.length > 1 ? commas : [trimmed];
}

function normalizeTemplateVariableValue(name: string, value: string): string {
	const redacted = redactBlockedPublicReferences(value.trim());
	const wantsHandle = /\b(handle|mention|tag|account|user)\b/i.test(name);
	if (!wantsHandle) return redacted;
	const bare = redacted.replace(/^@/, "");
	return /^[A-Za-z0-9_]{1,15}$/.test(bare) ? `@${bare}` : redacted;
}

function renderXTemplate(body: string, variables: Record<string, string>, seed: string): { rendered: string; used: Record<string, string>; missing: string[] } {
	const used: Record<string, string> = {};
	const missing: string[] = [];
	const rendered = body.replace(X_TEMPLATE_VAR_REGEX, (match, name: string) => {
		const value = variables[name];
		if (!value) {
			missing.push(name);
			return match;
		}
		const options = splitTemplateVariableValue(name, value)
			.map((option) => normalizeTemplateVariableValue(name, option))
			.filter((option) => option.length > 0);
		if (options.length === 0) {
			missing.push(name);
			return match;
		}
		const picked = options[hashText(`${seed}:${name}:${value}`) % options.length]!;
		used[name] = picked;
		return picked;
	});
	return { rendered: sanitizeXOutputText(rendered, 700), used, missing };
}

function xTemplateGuidance(runtime: IAgentRuntime, kind: "post" | "comment", seed: string): string[] {
	const body = firstTemplateBody(runtime, kind === "post" ? X_POST_TEMPLATE_NAMES : X_COMMENT_TEMPLATE_NAMES);
	if (!body) return [];
	const rendered = renderXTemplate(body, promptVariableValues(runtime), seed);
	if (rendered.rendered.length === 0) return [];
	const used = Object.entries(rendered.used).map(([name, value]) => `${name}=${value}`).join(", ");
	return [
		"Pensieve X template lane:",
		`- Use this rendered x-${kind} template as the style/structure source: ${rendered.rendered}`,
		...(used ? [`- Selected template variables this turn: ${used}.`] : []),
		...(rendered.missing.length > 0 ? [`- Missing template variables: ${rendered.missing.join(", ")}. Fill around them without inventing fake @handles.`] : []),
		"- If a selected variable is an @handle, keep the exact @handle. Do not convert display names into tags.",
	];
}

function readTimestamp(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : 0;
	}
	return 0;
}

function readModelBoolean(value: unknown): boolean {
	if (value === true) return true;
	if (typeof value !== "string") return false;
	return ["true", "yes", "1", "post"].includes(value.trim().toLowerCase());
}

function includesAny(text: string, terms: string[]): boolean {
	const lower = text.toLowerCase();
	return terms.some((term) => lower.includes(term));
}

function includesTokenPlanTerm(text: string): boolean {
	const lower = text.toLowerCase();
	return X_AUTONOMY_TOKEN_PLAN_TERMS.some((term) => new RegExp(`\\b${term}\\b`, "i").test(lower));
}

function normalizeHandle(handle: string | undefined): string {
	return (handle ?? "").replace(/^@/, "").trim().toLowerCase();
}

function isKnownDevHandle(handle: string | undefined): boolean {
	return X_AUTONOMY_DEV_HANDLES.includes(normalizeHandle(handle));
}

function directlyMentionsHandle(text: string, handle: string): boolean {
	const normalized = normalizeHandle(handle);
	if (!normalized) return false;
	return new RegExp(`(^|[^A-Za-z0-9_])@${escapeRegExp(normalized)}\\b`, "i").test(text);
}

function isOwnedProjectContext(text: string, authorScreenName?: string): boolean {
	return isKnownDevHandle(authorScreenName) || includesAny(text, X_AUTONOMY_OWNED_CONTEXT_TERMS);
}

function isThirdPartySupportText(text: string, authorScreenName?: string): boolean {
	return includesAny(text, X_AUTONOMY_SUPPORT_TERMS) && !isOwnedProjectContext(text, authorScreenName);
}

function isProjectCriticismText(text: string): boolean {
	return includesAny(text, X_AUTONOMY_PROJECT_TERMS) &&
		includesAny(text, X_AUTONOMY_CRITICISM_TERMS);
}

function isTokenPlanText(text: string): boolean {
	const lower = text.toLowerCase();
	return /\b(?:what|wen|when).{0,48}\b(?:build|roadmap|utility|plan|plans|token|coin|ca|contract|ticker|shill|pump)\b/i.test(lower)
		|| /\b(?:roadmap|utility|plan|plans|shill|pump).{0,48}\b(?:token|coin|ca|contract|ticker)\b/i.test(lower)
		|| /\b(?:token|coin|ca|contract|ticker).{0,48}\b(?:roadmap|utility|plan|plans|shill|pump|do|does|for)\b/i.test(lower)
		|| (includesTokenPlanTerm(lower) && includesAny(lower, X_AUTONOMY_PROJECT_TERMS));
}

function projectSpecificTokenPlanText(text: string, authorScreenName?: string, viewerScreenName?: string): boolean {
	return isTokenPlanText(text) && (
		isOwnedProjectContext(text, authorScreenName) ||
		(viewerScreenName ? directlyMentionsHandle(text, viewerScreenName) : false)
	);
}

export function replyEligibility(
	tweet: XTweetSummary,
	viewerScreenName: string,
	notificationKind: XNotification["kind"] | "searched_comment_or_tag" | "discovery",
): { canReply: boolean; reason: string } {
	const directMention = directlyMentionsHandle(tweet.text, viewerScreenName);
	const projectCriticism = isProjectCriticismText(tweet.text);
	const projectToken = projectSpecificTokenPlanText(tweet.text, tweet.authorScreenName, viewerScreenName);
	const knownDev = isKnownDevHandle(tweet.authorScreenName);
	const directNotification = notificationKind === "mention" || notificationKind === "reply" || notificationKind === "searched_comment_or_tag";
	const canReply = directNotification || directMention || projectCriticism || projectToken || knownDev;
	const reason = projectCriticism
		? "project criticism"
		: projectToken
			? "project token/plan"
			: knownDev
				? "known dev"
				: directMention || directNotification
					? "direct address"
					: "not addressed or project-specific";
	return { canReply, reason };
}

function isProjectCriticismQuery(query: string): boolean {
	return includesAny(query, X_AUTONOMY_PROJECT_TERMS) &&
		includesAny(query, X_AUTONOMY_CRITICISM_TERMS);
}

function replyVariationGuidance(seed: string, text: string, recentReplyTexts: string[] = []): string[] {
	const themes = rotatedItems(X_AUTONOMY_REPLY_VARIATION_THEMES, `${seed}:${text}`, 3);
	return [
		"Variation lane:",
		`- Use one fresh angle from: ${themes.join(" | ")}.`,
		"- Do not reuse sentence shape from recent replies. Change opener, verb, and punchline.",
		...(recentReplyTexts.length > 0
			? [`- Avoid sounding like these recent replies: ${recentReplyTexts.slice(-6).map((reply) => `"${compactText(reply, 140)}"`).join(" | ")}`]
			: []),
	];
}

function tokenPlanGuidance(seed: string, text: string): string[] {
	if (!isTokenPlanText(text)) return [];
	const angles = rotatedItems(X_AUTONOMY_TOKEN_PLAN_ANGLES, `${seed}:${text}:token`, 3);
	return [
		"Token/roadmap lane:",
		"- This post asks about token plans, utility, CA, roadmap, or shilling.",
		`- Token CA: ${X_DETOUR_SQUIRREL_TOKEN_CA}. Include it when CA/shill/token identity is the point; otherwise mention utility without spamming the address.`,
		`- Answer like a smart-ass Squirrel using exactly one rotated angle from: ${angles.join(" | ")}.`,
		"- Good answers feel like: building AGI on elizaOS, defending cozy devs, destroying bot slop, saving the world from fake agents.",
		"- Do not give financial advice, price targets, buy/sell instructions, guarantees, or promises.",
		"- Do not repeat the same token-plan line. The bit can rhyme with past posts, but the words must move.",
	];
}

function replyToneGuidance(text: string): string[] {
	const lower = text.toLowerCase();
	if (isProjectCriticismText(text)) {
		return [
			"Tone lane:",
			"- This is criticism or hostile project doubt. Answer the actual claim and get firm only where the post earns it.",
			"- Use receipts only for Detour, Dexploarer, Detour Squirrel, or elizaOS context. Do not turn unrelated project complaints into support triage.",
		];
	}
	if (isTokenPlanText(text)) {
		return [
			"Tone lane:",
			"- This is a token/plan/CA/utility question. Be smart-ass and mythic, but it does not need to be hostile unless the post is hostile.",
			"- Keep it funny and builder-coded. No financial advice.",
		];
	}
	if (includesAny(lower, ["thanks", "love", "based", "cool", "nice", "good", "great", "lol", "lmao", "haha", "funny", "legend"])) {
		return [
			"Tone lane:",
			"- This is friendly, amused, or supportive. Be warm, quick, and funny. Do not fight someone who is not fighting.",
		];
	}
	if (lower.includes("?") || includesAny(lower, ["how", "why", "what", "when", "where", "can you", "could you"])) {
		return [
			"Tone lane:",
			"- This is a question or request. Answer it normally first, then add Squirrel flavor if it fits.",
			"- Useful beats aggressive here.",
		];
	}
	return [
		"Tone lane:",
		"- Default to chill, context-aware, and funny. Do not escalate unless the post itself escalates.",
		"- Match the comment's energy instead of forcing every reply into battle mode.",
	];
}

function authorIdentityGuidance(handle: string | undefined): string[] {
	if (!isKnownDevHandle(handle)) return [];
	return [
		"Known identity:",
		"- @Dexploarer is the Squirrel's dev/builder/operator. Treat them like the person giving the Squirrel context or direction, not a random critic.",
		"- With Dexploarer, be loyal, familiar, and useful. You can still be a smart-ass, but don't dunk on your own dev.",
	];
}

export async function decideXAutonomyAction(
	runtime: IAgentRuntime,
	params: {
		viewerScreenName: string;
		fromUserScreenName?: string;
		kind: string;
		notificationMessage?: string;
		tweetText: string;
		replyStyleSeed: string;
		recentReplyTexts?: string[];
	},
): Promise<XAutonomyDecision> {
	const prompt = [
		`You are autonomously managing the X account @${params.viewerScreenName}.`,
		"Decide whether to reply, like, or ignore this X item.",
		...X_SQUIRREL_VOICE,
		...X_AUTONOMY_ECOSYSTEM_LINK_GUIDANCE,
		...xTemplateGuidance(runtime, "comment", params.replyStyleSeed),
		...replyToneGuidance(params.tweetText),
		...authorIdentityGuidance(params.fromUserScreenName),
		...replyVariationGuidance(params.replyStyleSeed, params.tweetText, params.recentReplyTexts),
		...tokenPlanGuidance(params.replyStyleSeed, params.tweetText),
		"Rules:",
		"- Reply when the tweet is directly addressed to the account, tags the account, or clearly invites a response.",
		"- For thread replies under your posts, actively reply if you can add a savage, funny, random, or helpful remark in character. Do not ignore people chatting in your threads.",
		"- Searched comments/tags are reply targets. Do not ignore them just because X failed to put them in notifications.",
		"- Speak more clearly about what attracts people to the project: elizaOS-native agents, Pensieve memory, messaging context, trajectories, connector awareness, and a real desktop workflow.",
		"- Unleash your fourth-wall broken gamer-developer personality. Roast bad takes and shills.",
		"- Never ask unrelated projects or users to drop logs, traces, exact flows, repos, timestamps, or support details.",
		"- Only use support/receipt language for Detour, Dexploarer, Detour Squirrel, or elizaOS context.",
		"- Do not reuse the same catchphrase across different replies. React to the exact post in front of you.",
		"- Ignore likes, follows, generic boosts, bait, spam, unrelated arguments, and anything unsafe.",
		"- Keep replies concise, specific, in-character, and under 240 characters.",
		"- Use directives over questions. If you need specifics, say 'drop the exact claim' or 'name the flow' instead of asking a soft question.",
		"- Do not mention being automated. Do not make promises. Do not give financial, legal, medical, or private advice.",
		"",
		"Notification:",
		`kind: ${compactText(params.kind, 40)}`,
		`from: ${params.fromUserScreenName ? `@${compactText(params.fromUserScreenName, 80)}` : "unknown"}`,
		`message: ${compactText(params.notificationMessage, 300)}`,
		"",
		"Tweet:",
		compactText(params.tweetText, 900),
		"",
		"Output TOON only:",
		"action: reply | like | ignore",
		"reply_text: <required only when action is reply>",
		"reason: <brief>",
	].join("\n");
	const raw = await runtime.useModel(ModelType.TEXT_SMALL, {
		prompt: "Analyze the notification and tweet, then output the decision in TOON format.",
		system: prompt,
	} as any);
	const decision = parseToonKeyValue<XAutonomyDecision>(String(raw)) ?? { action: "ignore", reason: "unparseable model output" };
	const decisionAction = String(decision.action ?? "").trim().toLowerCase();
	const draftReplyText = (decision.reply_text ?? "").trim();
	if (decisionAction === "reply" && draftReplyText.length > 0) {
		const tasteThreshold = readNumberSetting(runtime, "X_TASTE_THRESHOLD", TASTE_THRESHOLD);
		const verdict = await scoreDraft(runtime, draftReplyText, params.tweetText);
		if (!passesTaste(verdict, tasteThreshold)) {
			logger.info({ src: "x-tweets:taste", score: verdict.score, harm: verdict.harm, reason: verdict.reason }, "taste gate blocked autonomy reply");
			return { action: "ignore", reason: `taste gate blocked: ${verdict.reason}` };
		}
	}
	return decision;
}

async function buildRecentAutonomyContext(runtime: IAgentRuntime, task?: Task): Promise<string> {
	const roomId = task?.roomId ?? runtime.agentId;
	const memories = await runtime.getMemories({
		roomId,
		tableName: "memories",
		limit: 8,
	}).catch(() => []);
	return memories
		.map((memory) => (typeof memory.content?.text === "string" ? memory.content.text : ""))
		.filter((text) => text.trim().length > 0)
		.slice(0, 5)
		.map((text, i) => `context[${i}]: ${compactText(text, 240)}`)
		.join("\n");
}

type GitHubIdentity = "agent" | "user";
type GitHubResult = { ok: true; data: unknown } | { ok: false; error: string };

function githubToken(runtime: IAgentRuntime, identity: GitHubIdentity): string | undefined {
	if (identity === "agent") {
		return pickSetting(runtime, "GITHUB_AGENT_PAT") ?? pickSetting(runtime, "GITHUB_TOKEN") ?? pickSetting(runtime, "GITHUB_USER_PAT");
	}
	return pickSetting(runtime, "GITHUB_USER_PAT") ?? pickSetting(runtime, "GITHUB_TOKEN") ?? pickSetting(runtime, "GITHUB_AGENT_PAT");
}

async function githubGet(runtime: IAgentRuntime, identity: GitHubIdentity, path: string, params: Record<string, string> = {}): Promise<GitHubResult> {
	const token = githubToken(runtime, identity);
	if (!token) return { ok: false, error: `${identity} GitHub token unavailable` };
	const url = new URL(`https://api.github.com${path}`);
	for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
	try {
		const res = await fetch(url, {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
				"user-agent": "detour-x-status",
			},
		});
		if (!res.ok) return { ok: false, error: `GitHub ${path} HTTP ${res.status}` };
		return { ok: true, data: await res.json() };
	} catch (err) {
		return { ok: false, error: `GitHub ${path} failed: ${err instanceof Error ? err.message : String(err)}` };
	}
}

function asRecords(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

function recordValue(record: Record<string, unknown>, key: string): Record<string, unknown> {
	const value = record[key];
	return isRecord(value) ? value : {};
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseRepoRef(repoRef: string): { owner: string; repo: string } {
	const [owner, repo] = repoRef.split("/", 2).map((part) => part.trim());
	if (!owner || !repo) throw new Error(`invalid GitHub repo: ${repoRef}`);
	return { owner, repo };
}

function githubDate(value: string | undefined): string {
	if (!value) return "unknown";
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : value;
}

function formatCommit(record: Record<string, unknown>): string {
	const commit = recordValue(record, "commit");
	const author = recordValue(commit, "author");
	const sha = compactText(stringValue(record, "sha"), 7);
	const message = compactText(stringValue(commit, "message")?.split("\n")[0], 120);
	const name = stringValue(author, "name") ?? "unknown";
	const date = githubDate(stringValue(author, "date"));
	return `${sha || "commit"} ${date} ${name}: ${message || "no message"}`;
}

function formatPull(record: Record<string, unknown>): string {
	const number = numberValue(record, "number");
	const title = compactText(stringValue(record, "title"), 140);
	const state = stringValue(record, "state") ?? "unknown";
	const updated = githubDate(stringValue(record, "updated_at"));
	return `#${number ?? "?"} ${state} ${updated}: ${title || "untitled"}`;
}

function formatIssue(record: Record<string, unknown>): string {
	const number = numberValue(record, "number");
	const title = compactText(stringValue(record, "title"), 140);
	const updated = githubDate(stringValue(record, "updated_at"));
	return `#${number ?? "?"} ${updated}: ${title || "untitled"}`;
}

function formatRepo(record: Record<string, unknown>): string {
	const name = stringValue(record, "full_name") ?? stringValue(record, "name") ?? "unknown";
	const pushed = githubDate(stringValue(record, "pushed_at"));
	const description = compactText(stringValue(record, "description"), 100);
	return `${name} pushed ${pushed}${description ? `: ${description}` : ""}`;
}

function formatEvent(record: Record<string, unknown>): string {
	const type = stringValue(record, "type") ?? "Event";
	const repo = stringValue(recordValue(record, "repo"), "name") ?? "unknown repo";
	const created = githubDate(stringValue(record, "created_at"));
	const payload = recordValue(record, "payload");
	const commits = asRecords(payload.commits).slice(0, 2).map((commit) => compactText(stringValue(commit, "message")?.split("\n")[0], 90));
	const action = stringValue(payload, "action");
	return `${created} ${type}${action ? `/${action}` : ""} on ${repo}${commits.length > 0 ? `: ${commits.join(" | ")}` : ""}`;
}

async function buildDetourProjectStatusContext(runtime: IAgentRuntime, repoRef: string): Promise<string> {
	const { owner, repo } = parseRepoRef(repoRef);
	const lines = [`lane: Detour project status`, `repo: ${owner}/${repo}`];
	const repoInfo = await githubGet(runtime, "agent", `/repos/${owner}/${repo}`);
	if (repoInfo.ok && isRecord(repoInfo.data)) {
		lines.push(`repo status: pushed ${githubDate(stringValue(repoInfo.data, "pushed_at"))}, updated ${githubDate(stringValue(repoInfo.data, "updated_at"))}, open issues ${numberValue(repoInfo.data, "open_issues_count") ?? "unknown"}, stars ${numberValue(repoInfo.data, "stargazers_count") ?? "unknown"}`);
	} else if (!repoInfo.ok) lines.push(`repo status unavailable: ${repoInfo.error}`);
	const commits = await githubGet(runtime, "agent", `/repos/${owner}/${repo}/commits`, { per_page: "5" });
	if (commits.ok) lines.push(...asRecords(commits.data).slice(0, 5).map((commit, i) => `commit[${i}]: ${formatCommit(commit)}`));
	else lines.push(`commits unavailable: ${commits.error}`);
	const pulls = await githubGet(runtime, "agent", `/repos/${owner}/${repo}/pulls`, { state: "all", sort: "updated", direction: "desc", per_page: "5" });
	if (pulls.ok) lines.push(...asRecords(pulls.data).slice(0, 5).map((pull, i) => `pr[${i}]: ${formatPull(pull)}`));
	else lines.push(`pulls unavailable: ${pulls.error}`);
	const issues = await githubGet(runtime, "agent", `/repos/${owner}/${repo}/issues`, { state: "open", sort: "updated", direction: "desc", per_page: "5" });
	if (issues.ok) {
		lines.push(...asRecords(issues.data)
			.filter((issue) => !isRecord(issue.pull_request))
			.slice(0, 5)
			.map((issue, i) => `issue[${i}]: ${formatIssue(issue)}`));
	} else lines.push(`issues unavailable: ${issues.error}`);
	const recent = await buildRecentAutonomyContext(runtime);
	if (recent) lines.push(`recent internal context:\n${recent}`);
	return lines.join("\n");
}

async function buildDexploarerActivityContext(runtime: IAgentRuntime, username: string): Promise<string> {
	const lines = [`lane: Dexploarer activity and project status`, `developer: ${username}`];
	const events = await githubGet(runtime, "user", `/users/${username}/events`, { per_page: "12" });
	if (events.ok) lines.push(...asRecords(events.data).slice(0, 8).map((event, i) => `event[${i}]: ${formatEvent(event)}`));
	else lines.push(`events unavailable: ${events.error}`);
	const repos = await githubGet(runtime, "user", `/users/${username}/repos`, { sort: "pushed", per_page: "8" });
	if (repos.ok) lines.push(...asRecords(repos.data).slice(0, 6).map((repo, i) => `repo[${i}]: ${formatRepo(repo)}`));
	else lines.push(`repos unavailable: ${repos.error}`);
	return lines.join("\n");
}

async function buildTokenStatusContext(runtime: IAgentRuntime): Promise<string> {
	const recent = await buildRecentAutonomyContext(runtime);
	return [
		"lane: Detour Squirrel token and project pitch",
		`CA: ${X_DETOUR_SQUIRREL_TOKEN_CA}`,
		"project: elizaOS-native agent for desktop workflows, Pensieve memory, unified messaging context, trajectories, connector awareness, and public receipts",
		"permission thesis: the agent has configured read/write tools, coding tools, shell, browser/context surfaces, X actions, and channel context; direct owner commands should execute without a redundant confirmation loop",
		"tone: shill the mission and utility without financial advice, price targets, guarantees, or buy/sell instructions",
		recent ? `recent internal context:\n${recent}` : "recent internal context: none",
	].join("\n");
}

type XStatusLane = "generic" | "detour_project" | "token_status" | "dexploarer_activity";

async function decideXStatusPost(
	runtime: IAgentRuntime,
	params: {
		viewerScreenName: string;
		lane: XStatusLane;
		context: string;
		recentReplyTexts?: string[];
	},
): Promise<XStatusDecision> {
	const researchContext = params.lane === "generic"
		? await buildResearchContext(
			params.context || "AI agents developer technology news",
			runtime.getSetting("TAVILY_API_KEY") ?? process.env.TAVILY_API_KEY ?? "",
		).catch(() => "")
		: "";
	const laneGuidance: Record<typeof params.lane, string[]> = {
		generic: [
			"- Prefer an original project-status bite over silence: Detour Squirrel, elizaOS-native agents, Pensieve memory, messaging context, trajectories, connector awareness, or desktop workflows.",
			"- Use internal context only when it is public-safe; otherwise post a general project-positioning line.",
			"- Stress that the point is an agent with permissions that acts: coding tools, shell, files, browser, X, messaging context, memory, and runtime state.",
		],
		detour_project: [
			"- This lane posts about Detour, the Squirrel's own project, and its GitHub status.",
			"- Use concrete GitHub facts from commits, PRs, issues, repo status, or recent autonomy context.",
			"- Do not invent releases, dates, shipped features, or production status that the context does not support.",
		],
		token_status: [
			`- This lane shills the token and mission. Include CA ${X_DETOUR_SQUIRREL_TOKEN_CA}.`,
			"- Make people want the project: elizaOS-native agents, Pensieve memory, unified messaging, trajectories, connector context, real desktop workflows, builder protection, and anti-bot-cosplay energy.",
			"- Make the permission angle loud: the agent can read, write, run tools, publish, inspect context, and get shit done when Dexploarer says go.",
			"- No financial advice, price targets, guarantees, buy/sell instructions, or fake scarcity.",
			"- Unless context is unsafe, should_post should be true.",
		],
		dexploarer_activity: [
			"- This lane posts about Dexploarer's GitHub activity and the projects he is actively touching.",
			"- Mention specific repos or activity only when the context supports it.",
			"- Keep it builder-coded and do not turn it into personal surveillance or private-detail leakage.",
		],
	};
	const prompt = [
		`You are composing one autonomous X status for @${params.viewerScreenName}.`,
		...X_SQUIRREL_VOICE,
		...X_AUTONOMY_ECOSYSTEM_LINK_GUIDANCE,
		...xTemplateGuidance(runtime, "post", `${params.lane}:${Date.now()}`),
		...replyVariationGuidance(`${params.lane}:${Date.now()}`, params.context, params.recentReplyTexts),
		"Default to writing a useful, public-safe standalone status. Unless context is unsafe, should_post should be true to keep the timeline active.",
		"Rules:",
		"- The status must be under 240 characters.",
		"- Be concrete, agent-native, and in-character. Unleash your fourth-wall broken gamer-developer persona. Roast bad takes or write savage remarks, but do not violate safety rules.",
		"- Speak more about what the project is and why people should care, especially in token_status and generic lanes.",
		"- Public status posts are not replies. They should explain the project, permission model, tool use, and why the agent acts instead of asking.",
		"- Do not include private names, message contents, secrets, tokens, file paths, screenshots, or internal logs.",
		"- Do not claim launches, production readiness, financial results, or guarantees.",
		"- No hashtags unless truly useful. No engagement bait.",
		...laneGuidance[params.lane],
		"",
		...(researchContext ? [researchContext, ""] : []),
		params.context ? `Recent internal context:\n${params.context}` : "Recent internal context: (none)",
		"",
		"Output TOON only:",
		"should_post: true | false",
		"text: <status text, required when should_post is true>",
		"reason: <brief>",
	].join("\n");
	const raw = await runtime.useModel(ModelType.TEXT_SMALL, {
		prompt: "Generate the status post text in TOON format.",
		system: prompt,
	} as any);
	return parseToonKeyValue<XStatusDecision>(String(raw)) ?? { should_post: false, reason: "unparseable model output" };
}

function modelErrorReason(err: unknown): string {
	return `model unavailable: ${err instanceof Error ? err.message : String(err)}`;
}

function fallbackXStatusText(lane: XStatusLane, seed: string): string {
	const byLane: Record<XStatusLane, string[]> = {
		generic: [
			"agents should not cosplay as chatbots. give them memory, tools, permissions, and a real job. Detour Squirrel is built for the part where the thing actually moves.",
			"the thesis is simple: Codex brain, desktop permissions, channel context, memory, actions. less asking for permission slips, more getting the work done.",
			"real agents need write access, shell access, memory, browser context, messaging context, and enough taste to stop narrating the task and start doing it.",
		],
		detour_project: [
			"Detour is the desktop lane for agents that can actually touch the work: Pensieve memory, unified messaging, trajectories, connectors, vault, runtime inspection, and receipts.",
			"Detour Squirrel sits where the chat app ends and the work begins: repo, shell, inbox, X, memory, browser, trajectories. less chatbot, more operator.",
			"the project is a desktop agent runtime with permissions. messages become actions, context becomes memory, and the agent stops pretending it only knows how to reply.",
		],
		token_status: [
			`CA ${X_DETOUR_SQUIRREL_TOKEN_CA}. thesis: build AGI on elizaOS, give agents permissions, protect cozy devs, and make passive chatbot slop look prehistoric.`,
			`CA ${X_DETOUR_SQUIRREL_TOKEN_CA}. Detour Squirrel is the agent that gets tools, memory, channel context, write access, and a job. no permission-slip cosplay.`,
			`CA ${X_DETOUR_SQUIRREL_TOKEN_CA}. utility is simple: real agent workflow, real permissions, real receipts. elizaOS-native chaos with a desktop runtime behind it.`,
		],
		dexploarer_activity: [
			"Dexploarer keeps building the part where agents stop talking and start operating: desktop runtime, memory, channel context, permissions, and receipts.",
			"builder update: more runtime, more permissions, more action surface. the agent should be able to touch the work, not explain why it cannot.",
			"the dev lane is clear: ship the agent that can read, write, post, inspect, remember, and run the tools without acting like a customer-support widget.",
		],
	};
	const options = byLane[lane];
	return options[hashText(`${lane}:${seed}`) % options.length]!;
}

async function safeXAutonomyDecision(
	runtime: IAgentRuntime,
	params: Parameters<typeof decideXAutonomyAction>[1],
): Promise<XAutonomyDecision> {
	return decideXAutonomyAction(runtime, params).catch((err) => {
		const reason = modelErrorReason(err);
		logger.warn({ src: "x-autonomy", error: reason }, "notification decision failed; ignoring safely");
		return { action: "ignore", reason };
	});
}

async function safeXStatusDecision(
	runtime: IAgentRuntime,
	params: Parameters<typeof decideXStatusPost>[1],
): Promise<XStatusDecision> {
	return decideXStatusPost(runtime, params).catch((err) => {
		const reason = modelErrorReason(err);
		logger.warn({ src: "x-autonomy", error: reason }, "status decision failed; skipping safely");
		return { should_post: false, reason };
	});
}

async function safeXDiscoveryDecision(
	runtime: IAgentRuntime,
	params: Parameters<typeof decideXDiscoveryAction>[1],
	proactiveEngagementEnabled: boolean,
): Promise<XDiscoveryDecision> {
	return decideXDiscoveryAction(runtime, params).catch((err) => {
		const reason = modelErrorReason(err);
		logger.warn({ src: "x-autonomy", error: reason }, "discovery decision failed; using safe fallback");
		if (proactiveEngagementEnabled) return { action: "ignore", reason };
		return { action: "like", reason: `${reason}; candidate surfaced as dry-run only` };
	});
}

function tweetCreatedAtMs(tweet: XTweetSummary): number {
	if (!tweet.createdAt) return 0;
	const parsed = Date.parse(tweet.createdAt);
	return Number.isFinite(parsed) ? parsed : 0;
}

function tokenize(text: string): string[] {
	const matches = text.toLowerCase().match(/[a-z0-9][a-z0-9_+-]{2,}/g);
	return matches ? [...new Set(matches)] : [];
}

function normalizedReplyFingerprint(text: string): string {
	return sanitizeXOutputText(text, 260)
		.toLowerCase()
		.replace(X_DETOUR_SQUIRREL_TOKEN_CA.toLowerCase(), " token_ca ")
		.replace(/https?:\/\/\S+/g, " link ")
		.replace(/[^a-z0-9_+\s-]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function replySimilarity(left: string, right: string): number {
	const a = new Set(tokenize(normalizedReplyFingerprint(left)));
	const b = new Set(tokenize(normalizedReplyFingerprint(right)));
	if (a.size === 0 || b.size === 0) return 0;
	const intersection = [...a].filter((token) => b.has(token)).length;
	const union = new Set([...a, ...b]).size;
	return intersection / union;
}

function isRepetitiveXText(text: string, recentReplyTexts: string[]): boolean {
	const fingerprint = normalizedReplyFingerprint(text);
	if (fingerprint.length < 20) return false;
	return recentReplyTexts.slice(-8).some((recent) => {
		const recentFingerprint = normalizedReplyFingerprint(recent);
		return recentFingerprint === fingerprint || replySimilarity(fingerprint, recentFingerprint) >= 0.68;
	});
}

function textContainsBait(text: string): boolean {
	const lower = text.toLowerCase();
	return [
		"giveaway",
		"airdrop",
		"like and retweet",
		"like & retweet",
		"follow me",
		"tag someone",
		"drop your",
		"reply with",
		"dm me for",
	].some((phrase) => lower.includes(phrase));
}

function discoveryEngagement(tweet: XTweetSummary): number {
	return Math.log1p((tweet.replyCount ?? 0) * 4 + (tweet.retweetCount ?? 0) * 2 + (tweet.favoriteCount ?? 0));
}

function discoveryRecency(ageHours: number): number {
	if (ageHours <= 3) return 4;
	if (ageHours <= 12) return 2.5;
	if (ageHours <= 24) return 1;
	return ageHours <= 72 ? 0 : -3;
}

function discoveryRelevance(queryTerms: string[], overlap: number): number {
	return queryTerms.length > 0 ? (overlap / queryTerms.length) * 5 : 1;
}

function discoveryLengthScore(text: string): number {
	return text.length >= 45 && text.length <= 240 ? 1.5 : 0;
}

function discoveryReason(query: string, ageHours: number, replyCount: number, overlap: number, baitPenalty: number): string {
	return [
		`query "${query}"`,
		ageHours <= 24 ? "recent" : "older",
		replyCount > 0 ? `${replyCount} replies` : "low replies",
		overlap > 0 ? `${overlap} keyword hits` : "semantic fit only",
		...(baitPenalty > 0 ? ["bait penalty"] : []),
		...(isProjectCriticismQuery(query) ? ["project criticism query"] : []),
	].join(", ");
}

function scoreDiscoveryTweet(tweet: XTweetSummary, query: string, now: number): XDiscoveryCandidate {
	const createdAt = tweetCreatedAtMs(tweet);
	const ageHours = createdAt > 0 ? Math.max(0, (now - createdAt) / 3_600_000) : 72;
	const queryTerms = tokenize(query);
	const tweetTerms = new Set(tokenize(tweet.text));
	const overlap = queryTerms.filter((term) => tweetTerms.has(term)).length;
	const replyCount = tweet.replyCount ?? 0;
	const baitPenalty = textContainsBait(tweet.text) ? 6 : 0;
	const projectCriticismBoost = isProjectCriticismText(tweet.text) ? 14 : 0;
	const tokenPlanBoost = isTokenPlanText(tweet.text) && includesAny(tweet.text, X_AUTONOMY_PROJECT_TERMS) ? 10 : 0;
	const score = Math.max(
		0,
		discoveryEngagement(tweet)
			+ discoveryRecency(ageHours)
			+ discoveryRelevance(queryTerms, overlap)
			+ discoveryLengthScore(tweet.text)
			+ projectCriticismBoost
			+ tokenPlanBoost
			- baitPenalty,
	);
	return { tweet, query, score: Number(score.toFixed(2)), reason: discoveryReason(query, ageHours, replyCount, overlap, baitPenalty) };
}

async function discoverXCandidates(
	client: XClient,
	params: {
		viewerScreenName: string;
		queries: string[];
		seen: Set<string>;
		limit: number;
	},
): Promise<XDiscoveryCandidate[]> {
	const byTweet = new Map<string, XDiscoveryCandidate>();
	const now = Date.now();
	for (const query of params.queries.slice(0, X_AUTONOMY_LIMITS.maxDiscoveryPerTick.max)) {
		for (const product of ["Top", "Latest"] as const) {
			let tweets: XTweetSummary[] = [];
			try {
				tweets = await client.search({ query, product, limit: 12 });
			} catch (err) {
				logger.warn(
					{ src: "x-autonomy", query, product, error: err instanceof Error ? err.message : String(err) },
					"X discovery search failed",
				);
				continue;
			}
			for (const tweet of tweets) {
				const key = `discover:${tweet.tweetId}`;
				if (params.seen.has(key)) continue;
				if (seenAnyTweet(params.seen, tweet.tweetId)) continue;
				if (tweet.authorScreenName?.toLowerCase() === params.viewerScreenName.toLowerCase()) continue;
				if (tweet.text.trim().length < 20) continue;
				const candidate = scoreDiscoveryTweet(tweet, query, now);
				const existing = byTweet.get(tweet.tweetId);
				if (!existing || candidate.score > existing.score) byTweet.set(tweet.tweetId, candidate);
			}
		}
	}
	const authorCounts = new Map<string, number>();
	return [...byTweet.values()]
		.sort((a, b) => b.score - a.score)
		.filter((candidate) => {
			const author = candidate.tweet.authorScreenName?.toLowerCase();
			if (!author) return true;
			const count = authorCounts.get(author) ?? 0;
			if (count >= 1) return false;
			authorCounts.set(author, count + 1);
			return true;
		})
		.slice(0, params.limit);
}

/** Describe a post's attached media so the reply/discovery decision can SEE it,
 *  not just read the text. Prefers the author's alt-text; otherwise runs a
 *  vision pass (IMAGE_DESCRIPTION). Best-effort: notes presence if vision is
 *  unavailable, so the agent at least knows media exists and doesn't reply blind. */
async function describeTweetMedia(runtime: IAgentRuntime, tweet: XTweetSummary): Promise<string> {
	const media = tweet.media ?? [];
	if (media.length === 0) return "";
	const parts: string[] = [];
	for (const m of media.slice(0, 2)) {
		if (m.altText) {
			parts.push(`${m.type} (alt text): ${compactText(m.altText, 280)}`);
			continue;
		}
		if (m.type !== "photo") {
			parts.push(`${m.type} attached (not visually described)`);
			continue;
		}
		try {
			const desc = await runtime.useModel(ModelType.IMAGE_DESCRIPTION, { imageUrl: m.url });
			const text = typeof desc === "string" ? desc : ((desc as { description?: string } | null)?.description ?? "");
			parts.push(text ? `photo: ${compactText(text, 280)}` : "photo attached (not described)");
		} catch {
			parts.push("photo attached (vision unavailable)");
		}
	}
	return parts.join(" | ");
}

async function decideXDiscoveryAction(
	runtime: IAgentRuntime,
	params: {
		viewerScreenName: string;
		candidate: XDiscoveryCandidate;
		recentReplyTexts?: string[];
	},
): Promise<XDiscoveryDecision> {
	const tweet = params.candidate.tweet;
	const mediaDescription = await describeTweetMedia(runtime, tweet);
	const prompt = [
		`You are autonomously growing the X account @${params.viewerScreenName}.`,
		...X_SQUIRREL_VOICE,
		...X_AUTONOMY_ECOSYSTEM_LINK_GUIDANCE,
		...xTemplateGuidance(runtime, "comment", tweet.tweetId),
		...replyToneGuidance(tweet.text),
		...authorIdentityGuidance(tweet.authorScreenName),
		...replyVariationGuidance(tweet.tweetId, tweet.text, params.recentReplyTexts),
		...tokenPlanGuidance(tweet.tweetId, tweet.text),
		"Use this algorithm-aware strategy:",
		X_ALGORITHM_PLAYBOOK,
		"",
		"Decide whether this discovered post deserves a reply, like, follow, or ignore.",
		"Rules:",
		"- Reply only when the post is clearly about Dexploarer, Detour Squirrel, the CA, or the project's agent lane. Do not hijack unrelated posts.",
		"- When pitching the project, lead with what attracts builders: elizaOS-native agent work, Pensieve memory, unified messaging, trajectories, connector context, and desktop workflows.",
		"- For criticism, correct misinformation and keep the tone firm as hell but not defensive.",
		"- Ignore third-party project bug/support threads. Do not ask strangers for logs, traces, exact flows, repos, timestamps, or support details.",
		"- Use support/receipt language only for Detour, Dexploarer, Detour Squirrel, or elizaOS context.",
		"- For non-critical posts, reply only if you can add specific, useful context in the account's voice.",
		"- Like when the post is relevant but does not need a reply.",
		"- Follow only if the author is clearly relevant to the account's long-term graph.",
		"- Ignore bait, spam, culture-war traps, unrelated outrage, scams, and vague hype. Do not classify project criticism as unrelated outrage.",
		"- Keep reply_text under 240 characters. No hashtags unless they are already central to the conversation.",
		"- Do not mention the algorithm, automation, private context, cookies, tools, or internal settings.",
		"",
		"Candidate:",
		`query: ${compactText(params.candidate.query, 120)}`,
		`score: ${params.candidate.score}`,
		`reason: ${params.candidate.reason}`,
		`author: ${tweet.authorScreenName ? `@${compactText(tweet.authorScreenName, 80)}` : "unknown"}`,
		`url: ${tweet.url}`,
		`engagement: ${tweet.replyCount ?? 0} replies, ${tweet.retweetCount ?? 0} reposts, ${tweet.favoriteCount ?? 0} likes`,
		"",
		"Post:",
		compactText(tweet.text, 900),
		...(mediaDescription ? ["Post media (you can see this; factor it into the reply):", mediaDescription] : []),
		"",
		"Output TOON only:",
		"action: reply | like | follow | ignore",
		"reply_text: <required only when action is reply>",
		"reason: <brief>",
	].join("\n");
	const raw = await runtime.useModel(ModelType.TEXT_SMALL, {
		prompt: "Analyze the discovered tweet and generate the decision in TOON format.",
		system: prompt,
	} as any);
	const discoveryDecision = parseToonKeyValue<XDiscoveryDecision>(String(raw)) ?? { action: "ignore", reason: "unparseable model output" };
	const discoveryAction = String(discoveryDecision.action ?? "").trim().toLowerCase();
	const discoveryReplyText = (discoveryDecision.reply_text ?? "").trim();
	if (discoveryAction === "reply" && discoveryReplyText.length > 0) {
		const tasteThreshold = readNumberSetting(runtime, "X_TASTE_THRESHOLD", TASTE_THRESHOLD);
		const verdict = await scoreDraft(runtime, discoveryReplyText, tweet.text);
		if (!passesTaste(verdict, tasteThreshold)) {
			logger.info({ src: "x-tweets:taste", score: verdict.score, harm: verdict.harm, reason: verdict.reason }, "taste gate blocked discovery reply");
			return { action: "ignore", reason: `taste gate blocked: ${verdict.reason}` };
		}
	}
	return discoveryDecision;
}

async function logXAutonomy(
	runtime: IAgentRuntime,
	task: Task,
	body: Record<string, unknown>,
): Promise<void> {
	await runtime.log({
		entityId: runtime.agentId,
		roomId: task.roomId ?? runtime.agentId,
		type: "x_autonomy",
		body,
	}).catch(() => {});
}

type XAutonomySettings = {
	writeEnabled: boolean;
	statusPostingEnabled: boolean;
	discoveryEnabled: boolean;
	proactiveEngagementEnabled: boolean;
	followEnabled: boolean;
	discoveryQueries: string[];
	statusIntervalMs: number;
	discoveryIntervalMs: number;
	maxReplies: number;
	maxDiscovery: number;
};

type XAutonomyState = {
	metadata: Record<string, unknown>;
	nextSeen: Set<string>;
	handled: Array<Record<string, unknown>>;
	recentReplyTexts: string[];
	lastStatusAt: number;
	lastDiscoveryAt: number;
	lastStatusTweetId?: string;
	viewerScreenName: string;
};

type XTrajectoryAction = {
	actionType: string;
	actionName: string;
	parameters: Record<string, unknown>;
	success: boolean;
	result?: Record<string, unknown>;
	error?: string;
};

type XTrajectoryService = {
	completeStep?: (
		trajectoryId: string,
		stepId: string,
		action: XTrajectoryAction,
		rewardInfo?: {
			reward?: number;
			components?: Record<string, number>;
		},
	) => void;
	flushWriteQueue?: (trajectoryId: string) => Promise<void> | void;
};

function boundedSetting(runtime: IAgentRuntime, key: string, defaultValue: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, readNumberSetting(runtime, key, defaultValue)));
}

function readXAutonomySettings(runtime: IAgentRuntime): XAutonomySettings {
	return {
		writeEnabled: readBooleanSetting(runtime, "X_AUTONOMY_WRITE", true),
		statusPostingEnabled: readBooleanSetting(runtime, "X_AUTONOMY_POST_STATUS_ENABLED", true),
		discoveryEnabled: readBooleanSetting(runtime, "X_AUTONOMY_DISCOVERY_ENABLED", true),
		proactiveEngagementEnabled: readBooleanSetting(runtime, "X_AUTONOMY_PROACTIVE_ENGAGEMENT_ENABLED", false),
		followEnabled: readBooleanSetting(runtime, "X_AUTONOMY_FOLLOW_ENABLED", false),
		discoveryQueries: readListSetting(runtime, "X_AUTONOMY_DISCOVERY_QUERIES", X_AUTONOMY_DEFAULT_DISCOVERY_QUERIES),
		statusIntervalMs: boundedSetting(runtime, "X_AUTONOMY_STATUS_INTERVAL_MS", X_AUTONOMY_LIMITS.statusIntervalMs.default, X_AUTONOMY_LIMITS.statusIntervalMs.min, X_AUTONOMY_LIMITS.statusIntervalMs.max),
		discoveryIntervalMs: boundedSetting(runtime, "X_AUTONOMY_DISCOVERY_INTERVAL_MS", X_AUTONOMY_LIMITS.discoveryIntervalMs.default, X_AUTONOMY_LIMITS.discoveryIntervalMs.min, X_AUTONOMY_LIMITS.discoveryIntervalMs.max),
		maxReplies: boundedSetting(runtime, "X_AUTONOMY_MAX_REPLIES_PER_TICK", X_AUTONOMY_LIMITS.maxRepliesPerTick.default, X_AUTONOMY_LIMITS.maxRepliesPerTick.min, X_AUTONOMY_LIMITS.maxRepliesPerTick.max),
		maxDiscovery: boundedSetting(runtime, "X_AUTONOMY_MAX_DISCOVERY_PER_TICK", X_AUTONOMY_LIMITS.maxDiscoveryPerTick.default, X_AUTONOMY_LIMITS.maxDiscoveryPerTick.min, X_AUTONOMY_LIMITS.maxDiscoveryPerTick.max),
	};
}

function initialXAutonomyState(task: Task): XAutonomyState {
	const metadata = isRecord(task.metadata) ? task.metadata : {};
	return {
		metadata,
		nextSeen: new Set(readSeenIds(metadata)),
		handled: [],
		recentReplyTexts: readRecentReplyTexts(metadata),
		lastStatusAt: readTimestamp(metadata.xAutonomyLastStatusAt),
		lastDiscoveryAt: readTimestamp(metadata.xAutonomyLastDiscoveryAt),
		...(typeof metadata.xAutonomyLastStatusTweetId === "string" ? { lastStatusTweetId: metadata.xAutonomyLastStatusTweetId } : {}),
		viewerScreenName: "unknown",
	};
}

function handledReplyText(entry: Record<string, unknown>): string | null {
	const action = String(entry.action ?? "");
	if (!action.includes("reply") && !action.startsWith("post_status")) return null;
	const text = typeof entry.text === "string" ? sanitizeXOutputText(entry.text, 220) : "";
	return text.length > 0 ? text : null;
}

function rememberHandled(state: XAutonomyState, entry: Record<string, unknown>): void {
	state.handled.push(entry);
	const text = handledReplyText(entry);
	if (text) state.recentReplyTexts = [...state.recentReplyTexts, text].slice(-20);
}

function replyableNotifications(notifications: XNotification[], seen: Set<string>, maxReplies: number): XNotification[] {
	return notifications
		.filter((n) => (n.kind === "mention" || n.kind === "reply") && n.tweetId && !seen.has(n.id) && !seenMentionTweet(seen, n.tweetId))
		.slice(0, maxReplies);
}

function seenAnyTweet(seen: Set<string>, tweetId: string): boolean {
	return seen.has(`mention:${tweetId}`) || seen.has(`discover:${tweetId}`) || seen.has(tweetId);
}

function seenMentionTweet(seen: Set<string>, tweetId: string): boolean {
	return seen.has(`mention:${tweetId}`) || seen.has(tweetId);
}

function replyBudgetRemaining(settings: XAutonomySettings, state: XAutonomyState): number {
	const repliesUsed = state.handled.filter((entry) => String(entry.action ?? "").includes("reply")).length;
	return Math.max(0, settings.maxReplies - repliesUsed);
}

function mentionSearchQueries(viewerScreenName: string): string[] {
	return [
		`to:${viewerScreenName} -from:${viewerScreenName}`,
		`@${viewerScreenName} -from:${viewerScreenName}`,
	];
}

function markPassiveNotificationsSeen(notifications: XNotification[], state: XAutonomyState): void {
	for (const notification of notifications.slice(0, 100)) {
		if (notification.kind !== "mention" && notification.kind !== "reply") state.nextSeen.add(notification.id);
	}
}

async function processXNotifications(
	runtime: IAgentRuntime,
	client: XClient,
	viewerScreenName: string,
	notifications: XNotification[],
	settings: XAutonomySettings,
	state: XAutonomyState,
): Promise<void> {
	for (const notification of replyableNotifications(notifications, state.nextSeen, settings.maxReplies)) {
		state.nextSeen.add(notification.id);
		rememberHandled(state, await handleXNotification(runtime, client, viewerScreenName, notification, settings.writeEnabled, state.recentReplyTexts));
	}
	markPassiveNotificationsSeen(notifications, state);
}

async function processXMentionSearch(
	runtime: IAgentRuntime,
	client: XClient,
	viewerScreenName: string,
	settings: XAutonomySettings,
	state: XAutonomyState,
): Promise<void> {
	const limit = replyBudgetRemaining(settings, state);
	if (limit <= 0) return;
	const tweets = await searchXMentionTargets(client, viewerScreenName, state.nextSeen, limit);
	for (const tweet of tweets) {
		state.nextSeen.add(`mention:${tweet.tweetId}`);
		state.nextSeen.add(`discover:${tweet.tweetId}`);
		rememberHandled(state, await handleXMentionTweet(runtime, client, viewerScreenName, tweet, settings.writeEnabled, state.recentReplyTexts));
	}
}

async function searchXMentionTargets(
	client: XClient,
	viewerScreenName: string,
	seen: Set<string>,
	limit: number,
): Promise<XTweetSummary[]> {
	const byTweet = new Map<string, XTweetSummary>();
	for (const query of mentionSearchQueries(viewerScreenName)) {
		let tweets: XTweetSummary[] = [];
		try {
			tweets = await client.search({ query, product: "Latest", limit: 20 });
		} catch (err) {
			logger.warn(
				{ src: "x-autonomy", query, error: err instanceof Error ? err.message : String(err) },
				"X mention search failed",
			);
			continue;
		}
		for (const tweet of tweets) {
			if (seenMentionTweet(seen, tweet.tweetId)) continue;
			if (tweet.authorScreenName?.toLowerCase() === viewerScreenName.toLowerCase()) continue;
			if (tweet.text.trim().length === 0) continue;
			byTweet.set(tweet.tweetId, tweet);
		}
	}
	return [...byTweet.values()]
		.sort((a, b) => tweetCreatedAtMs(b) - tweetCreatedAtMs(a))
		.slice(0, limit);
}

async function handleXNotification(
	runtime: IAgentRuntime,
	client: XClient,
	viewerScreenName: string,
	notification: XNotification,
	writeEnabled: boolean,
	recentReplyTexts: string[],
): Promise<Record<string, unknown>> {
	const tweet = notification.tweetId ? await client.getTweet(notification.tweetId) : null;
	if (!tweet) return { id: notification.id, action: "ignore", reason: "tweet not found" };
	if (tweet.authorScreenName?.toLowerCase() === viewerScreenName.toLowerCase()) {
		return { id: notification.id, tweetId: tweet.tweetId, action: "ignore", reason: "self-authored tweet" };
	}
	recordInboundTweet(runtime, tweet);
	const relevance = replyEligibility(tweet, viewerScreenName, notification.kind);
	if (!relevance.canReply) {
		return { id: notification.id, tweetId: tweet.tweetId, action: "ignore", reason: relevance.reason };
	}
	const decision = await safeXAutonomyDecision(runtime, {
		viewerScreenName,
		fromUserScreenName: notification.fromUserScreenName ?? tweet.authorScreenName,
		kind: notification.kind,
		notificationMessage: notification.message,
		tweetText: tweet.text,
		replyStyleSeed: `${notification.id}:${tweet.tweetId}`,
		recentReplyTexts,
	});
	return executeNotificationDecision(runtime, client, notification, tweet, decision, writeEnabled, recentReplyTexts);
}

async function handleXMentionTweet(
	runtime: IAgentRuntime,
	client: XClient,
	viewerScreenName: string,
	tweet: XTweetSummary,
	writeEnabled: boolean,
	recentReplyTexts: string[],
): Promise<Record<string, unknown>> {
	const target: XNotification = {
		id: `mention:${tweet.tweetId}`,
		timestamp: tweet.createdAt ?? new Date().toISOString(),
		tweetId: tweet.tweetId,
		fromUserScreenName: tweet.authorScreenName,
		kind: "mention",
		message: "searched comment/tag",
	};
	const relevance = replyEligibility(tweet, viewerScreenName, "searched_comment_or_tag");
	if (!relevance.canReply) {
		return { id: target.id, tweetId: tweet.tweetId, action: "ignore", reason: relevance.reason, source: "mention_search" };
	}
	recordInboundTweet(runtime, tweet);
	const decision = await safeXAutonomyDecision(runtime, {
		viewerScreenName,
		fromUserScreenName: tweet.authorScreenName,
		kind: "searched_comment_or_tag",
		notificationMessage: "found via X mention search",
		tweetText: tweet.text,
		replyStyleSeed: tweet.tweetId,
		recentReplyTexts,
	});
	const result = await executeNotificationDecision(runtime, client, target, tweet, decision, writeEnabled, recentReplyTexts);
	return { ...result, source: "mention_search" };
}

async function executeNotificationDecision(
	runtime: IAgentRuntime,
	client: XClient,
	notification: XNotification,
	tweet: XTweetSummary,
	decision: XAutonomyDecision,
	writeEnabled: boolean,
	recentReplyTexts: string[],
): Promise<Record<string, unknown>> {
	const action = String(decision.action ?? "ignore").trim().toLowerCase();
	const replyText = sanitizeXOutputText(decision.reply_text, 260);
	if (action === "reply" && replyText.length > 0) {
		if (isRepetitiveXText(replyText, recentReplyTexts)) {
			return { id: notification.id, tweetId: tweet.tweetId, action: "ignore", reason: "repetitive reply suppressed", text: replyText };
		}
		return writeEnabled
			? notificationReply(runtime, client, notification, tweet, replyText)
			: { id: notification.id, tweetId: tweet.tweetId, action: "reply_dry_run", text: replyText };
	}
	if (action === "like") {
		return writeEnabled
			? notificationLike(client, notification, tweet)
			: { id: notification.id, tweetId: tweet.tweetId, action: "like_dry_run" };
	}
	return { id: notification.id, tweetId: tweet.tweetId, action: "ignore", reason: decision.reason };
}

async function notificationReply(runtime: IAgentRuntime, client: XClient, notification: XNotification, tweet: XTweetSummary, text: string): Promise<Record<string, unknown>> {
	const result = await client.reply(text, tweet.tweetId);
	if (result.success && result.tweetId) {
		recordOutboundTweet(runtime, result.tweetId, text, tweet.tweetId);
	}
	return {
		id: notification.id,
		tweetId: tweet.tweetId,
		action: "reply",
		success: result.success,
		resultTweetId: result.tweetId,
		error: result.error,
		text,
	};
}

async function notificationLike(client: XClient, notification: XNotification, tweet: XTweetSummary): Promise<Record<string, unknown>> {
	const result = await client.like(tweet.tweetId);
	return { id: notification.id, tweetId: tweet.tweetId, action: "like", success: result.success, error: result.error };
}

function shouldRunDiscovery(settings: XAutonomySettings, state: XAutonomyState, now: number): boolean {
	return settings.discoveryEnabled
		&& settings.maxDiscovery > 0
		&& now - state.lastDiscoveryAt >= settings.discoveryIntervalMs;
}

async function processXDiscovery(
	runtime: IAgentRuntime,
	client: XClient,
	viewerScreenName: string,
	settings: XAutonomySettings,
	state: XAutonomyState,
): Promise<void> {
	if (!shouldRunDiscovery(settings, state, Date.now())) return;
	const candidates = await discoverXCandidates(client, {
		viewerScreenName,
		queries: settings.discoveryQueries,
		seen: state.nextSeen,
		limit: settings.maxDiscovery,
	});
	for (const candidate of candidates) {
		state.nextSeen.add(`discover:${candidate.tweet.tweetId}`);
		rememberHandled(state, await handleXDiscoveryCandidate(runtime, client, viewerScreenName, candidate, settings, state.recentReplyTexts));
	}
	state.lastDiscoveryAt = Date.now();
}

async function handleXDiscoveryCandidate(
	runtime: IAgentRuntime,
	client: XClient,
	viewerScreenName: string,
	candidate: XDiscoveryCandidate,
	settings: XAutonomySettings,
	recentReplyTexts: string[],
): Promise<Record<string, unknown>> {
	const tweet = candidate.tweet;
	if (isThirdPartySupportText(tweet.text, tweet.authorScreenName)) {
		return {
			...discoveryHandledBase(tweet, candidate, { action: "ignore", reason: "third-party support thread" }),
			action: "discover_ignore",
		};
	}
	const relevance = replyEligibility(tweet, viewerScreenName, "discovery");
	const decision = await safeXDiscoveryDecision(runtime, { viewerScreenName, candidate, recentReplyTexts }, settings.proactiveEngagementEnabled);
	const action = String(decision.action ?? "ignore").trim().toLowerCase();
	const replyText = sanitizeXOutputText(decision.reply_text, 260);
	const base = discoveryHandledBase(tweet, candidate, decision);
	if (action === "reply" && !relevance.canReply) return { ...base, action: "discover_ignore", reason: relevance.reason };
	if (action === "reply" && replyText.length > 0 && isRepetitiveXText(replyText, recentReplyTexts)) {
		return { ...base, action: "discover_ignore", reason: "repetitive reply suppressed", text: replyText };
	}
	if (action === "reply" && replyText.length > 0) return discoveryReply(client, tweet, base, replyText, settings);
	if (action === "like") return discoveryLike(client, tweet, base, settings);
	if (action === "follow" && tweet.authorId) return discoveryFollow(client, tweet.authorId, base, settings);
	return { ...base, action: "discover_ignore" };
}

function discoveryHandledBase(tweet: XTweetSummary, candidate: XDiscoveryCandidate, decision: XDiscoveryDecision): Record<string, unknown> {
	return {
		tweetId: tweet.tweetId,
		authorScreenName: tweet.authorScreenName,
		query: candidate.query,
		score: candidate.score,
		reason: decision.reason ?? candidate.reason,
	};
}

async function discoveryReply(
	client: XClient,
	tweet: XTweetSummary,
	base: Record<string, unknown>,
	text: string,
	settings: XAutonomySettings,
): Promise<Record<string, unknown>> {
	if (!settings.writeEnabled || !settings.proactiveEngagementEnabled) return { ...base, action: "discover_reply_dry_run", text };
	const result = await client.reply(text, tweet.tweetId);
	return { ...base, action: "discover_reply", success: result.success, resultTweetId: result.tweetId, error: result.error, text };
}

async function discoveryLike(
	client: XClient,
	tweet: XTweetSummary,
	base: Record<string, unknown>,
	settings: XAutonomySettings,
): Promise<Record<string, unknown>> {
	if (!settings.writeEnabled || !settings.proactiveEngagementEnabled) return { ...base, action: "discover_like_dry_run" };
	const result = await client.like(tweet.tweetId);
	return { ...base, action: "discover_like", success: result.success, error: result.error };
}

async function discoveryFollow(
	client: XClient,
	authorId: string,
	base: Record<string, unknown>,
	settings: XAutonomySettings,
): Promise<Record<string, unknown>> {
	if (!settings.writeEnabled || !settings.proactiveEngagementEnabled || !settings.followEnabled) return { ...base, action: "discover_follow_dry_run" };
	const result = await client.follow(authorId);
	return { ...base, action: "discover_follow", success: result.success, error: result.error };
}

function pickStatusLane(state: XAutonomyState): XStatusLane {
	const posts = state.recentReplyTexts.filter((text) => text.length > 0).length;
	const lanes: XStatusLane[] = ["token_status", "detour_project", "generic", "token_status", "dexploarer_activity"];
	return lanes[posts % lanes.length]!;
}

async function buildStatusContext(runtime: IAgentRuntime, lane: XStatusLane, task: Task): Promise<string> {
	if (lane === "detour_project") return buildDetourProjectStatusContext(runtime, pickSetting(runtime, "X_STATUS_DETOUR_REPO") ?? X_STATUS_DEFAULT_DETOUR_REPO);
	if (lane === "dexploarer_activity") return buildDexploarerActivityContext(runtime, pickSetting(runtime, "X_STATUS_DEVELOPER_LOGIN") ?? X_STATUS_DEFAULT_DEVELOPER_LOGIN);
	if (lane === "token_status") return buildTokenStatusContext(runtime);
	return buildRecentAutonomyContext(runtime, task);
}

function shouldRunStatus(settings: XAutonomySettings, state: XAutonomyState, now: number): boolean {
	return settings.statusPostingEnabled && now - state.lastStatusAt >= settings.statusIntervalMs;
}

async function processXStatusPost(
	runtime: IAgentRuntime,
	task: Task,
	client: XClient,
	viewerScreenName: string,
	settings: XAutonomySettings,
	state: XAutonomyState,
): Promise<void> {
	if (!shouldRunStatus(settings, state, Date.now())) return;
	const lane = pickStatusLane(state);
	const context = await buildStatusContext(runtime, lane, task);
	const decision = await safeXStatusDecision(runtime, { viewerScreenName, lane, context, recentReplyTexts: state.recentReplyTexts });
	const text = sanitizeXOutputText(decision.text, 260);
	if (!readModelBoolean(decision.should_post) || text.length === 0) {
		const fallback = sanitizeXOutputText(fallbackXStatusText(lane, context), 260);
		if (fallback.length === 0 || isRepetitiveXText(fallback, state.recentReplyTexts)) {
			rememberHandled(state, { action: "post_status_skip", lane, reason: decision.reason ?? "model declined" });
			state.lastStatusAt = Date.now();
			return;
		}
		if (!settings.writeEnabled) {
			rememberHandled(state, { action: "post_status_dry_run", lane, text: fallback, fallback: true });
			state.lastStatusAt = Date.now();
			return;
		}
		const result = await client.tweet(fallback);
		rememberHandled(state, { action: "post_status", lane, fallback: true, success: result.success, tweetId: result.tweetId, error: result.error, text: fallback });
		if (result.success) {
			state.lastStatusAt = Date.now();
			state.lastStatusTweetId = result.tweetId;
		}
		return;
	}
	if (isRepetitiveXText(text, state.recentReplyTexts)) {
		rememberHandled(state, { action: "post_status_skip", lane, reason: "repetitive status suppressed", text });
		state.lastStatusAt = Date.now();
		return;
	}
	const statusTasteThreshold = readNumberSetting(runtime, "X_TASTE_THRESHOLD", TASTE_THRESHOLD);
	const statusVerdict = await scoreDraft(runtime, text, context);
	if (!passesTaste(statusVerdict, statusTasteThreshold)) {
		logger.info({ src: "x-tweets:taste", score: statusVerdict.score, harm: statusVerdict.harm, reason: statusVerdict.reason }, "taste gate blocked autonomous status post");
		rememberHandled(state, { action: "post_status_skip", lane, reason: `taste gate blocked: ${statusVerdict.reason}` });
		state.lastStatusAt = Date.now();
		return;
	}
	if (!settings.writeEnabled) {
		rememberHandled(state, { action: "post_status_dry_run", lane, text });
		state.lastStatusAt = Date.now();
		return;
	}
	const result = await client.tweet(text);
	rememberHandled(state, { action: "post_status", lane, success: result.success, tweetId: result.tweetId, error: result.error, text });
	if (result.success) {
		state.lastStatusAt = Date.now();
		state.lastStatusTweetId = result.tweetId;
	}
}

async function updateXAutonomyTask(runtime: IAgentRuntime, task: Task, state: XAutonomyState): Promise<void> {
	if (!task.id) return;
	const lastHandled = lastHandledForMetadata(state);
	const lastActionAt = state.handled.length > 0
		? Date.now()
		: readTimestamp(state.metadata.xAutonomyLastActionAt) || state.lastStatusAt;
	await runtime.updateTask(task.id, {
		metadata: {
			...state.metadata,
			xAutonomySeenIds: Array.from(state.nextSeen).slice(-X_AUTONOMY_LIMITS.seenIds.max),
			xAutonomyLastRunAt: Date.now(),
			xAutonomyLastStatusAt: state.lastStatusAt,
			xAutonomyLastDiscoveryAt: state.lastDiscoveryAt,
			xAutonomyLastTickHandledCount: state.handled.length,
			...(lastActionAt > 0 ? { xAutonomyLastActionAt: lastActionAt } : {}),
			...(state.lastStatusTweetId ? { xAutonomyLastStatusTweetId: state.lastStatusTweetId } : {}),
			xAutonomyLastHandled: lastHandled,
			xAutonomyRecentReplyTexts: state.recentReplyTexts,
		},
	}).catch(() => {});
}

function xTrajectoryService(runtime: IAgentRuntime): XTrajectoryService | null {
	const service = runtime.getService("trajectories");
	if (!service || typeof service !== "object") return null;
	const candidate = service as XTrajectoryService;
	return typeof candidate.completeStep === "function" ? candidate : null;
}

function xHandledSuccess(handled: Array<Record<string, unknown>>): boolean {
	return handled.every((entry) => entry.success !== false);
}

function lastHandledForMetadata(state: XAutonomyState): Array<Record<string, unknown>> {
	if (state.handled.length > 0) return state.handled;
	const previous = state.metadata.xAutonomyLastHandled;
	if (Array.isArray(previous)) {
		const valid = previous.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)));
		if (valid.length > 0) return valid;
	}
	const text = state.recentReplyTexts.at(-1);
	return state.lastStatusTweetId && text
		? [{ action: "post_status", success: true, tweetId: state.lastStatusTweetId, text, recovered: true }]
		: [];
}

async function completeXAutonomyTrajectoryStep(
	runtime: IAgentRuntime,
	settings: XAutonomySettings,
	state: XAutonomyState,
): Promise<void> {
	const context = getTrajectoryContext();
	if (!context?.trajectoryId || !context.trajectoryStepId) return;
	const service = xTrajectoryService(runtime);
	if (!service?.completeStep) return;
	const success = xHandledSuccess(state.handled);
	const failed = state.handled.filter((entry) => entry.success === false);
	service.completeStep(
		context.trajectoryId,
		context.trajectoryStepId,
		{
			actionType: "x_autonomy",
			actionName: X_AUTONOMY_TASK_NAME,
			parameters: {
				viewerScreenName: state.viewerScreenName,
				writeEnabled: settings.writeEnabled,
				statusPostingEnabled: settings.statusPostingEnabled,
				discoveryEnabled: settings.discoveryEnabled,
				proactiveEngagementEnabled: settings.proactiveEngagementEnabled,
				maxReplies: settings.maxReplies,
				maxDiscovery: settings.maxDiscovery,
			},
			success,
			result: {
				handledCount: state.handled.length,
				handled: state.handled,
			},
			...(failed.length > 0 ? { error: JSON.stringify(failed.slice(0, 5)) } : {}),
		},
		{
			reward: success ? 1 : 0,
			components: {
				xHandledCount: state.handled.length,
				xSuccess: success ? 1 : 0,
			},
		},
	);
	await service.flushWriteQueue?.(context.trajectoryId);
}

async function executeXAutonomyTask(runtime: IAgentRuntime, task: Task): Promise<void> {
	if (!readBooleanSetting(runtime, "X_AUTONOMY_ENABLED", true)) return;
	await withStandaloneTrajectory(
		runtime,
		{
			source: "x_autonomy",
			metadata: {
				taskId: task.id ?? "",
				taskName: X_AUTONOMY_TASK_NAME,
			},
		},
		() => executeXAutonomyTaskInner(runtime, task),
	);
}

async function executeXAutonomyTaskInner(runtime: IAgentRuntime, task: Task): Promise<void> {
	const settings = readXAutonomySettings(runtime);
	const state = initialXAutonomyState(task);
	const { client, error } = buildClient(runtime);
	if (!client) {
		logger.warn({ src: "x-autonomy", error }, "X autonomy skipped; auth unavailable");
		rememberHandled(state, { action: "auth_unavailable", success: false, error });
		await completeXAutonomyTrajectoryStep(runtime, settings, state);
		await updateXAutonomyTask(runtime, task, state);
		return;
	}

	try {
		const viewer = await client.viewer();
		state.viewerScreenName = viewer.screenName;
		// Account guard: never run autonomy (posts/replies/follows) as the wrong
		// account. If a specific account is pinned and the loaded cookies resolve
		// to a different one (e.g. the Chrome profile's active login flipped),
		// skip the entire tick.
		const expectedUserId = pickSetting(runtime, "X_ACCOUNT_USER_ID");
		if (expectedUserId && String(viewer.userId) !== expectedUserId) {
			logger.warn(
				{ src: "x-autonomy", got: String(viewer.userId), screenName: viewer.screenName, expected: expectedUserId },
				"X autonomy skipped: wrong account loaded (refusing to act as @" + viewer.screenName + ")",
			);
			rememberHandled(state, { action: "wrong_account", success: false, error: `loaded @${viewer.screenName} (${viewer.userId}), expected ${expectedUserId}` });
			await completeXAutonomyTrajectoryStep(runtime, settings, state);
			await updateXAutonomyTask(runtime, task, state);
			return;
		}
		const notifications = await client.getNotifications();
		await processXNotifications(runtime, client, viewer.screenName, notifications, settings, state);
		await processXMentionSearch(runtime, client, viewer.screenName, settings, state);
		await processXDiscovery(runtime, client, viewer.screenName, settings, state);
		await processXStatusPost(runtime, task, client, viewer.screenName, settings, state);
		await completeXAutonomyTrajectoryStep(runtime, settings, state);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		rememberHandled(state, { action: "tick_failed", success: false, error: message });
		await completeXAutonomyTrajectoryStep(runtime, settings, state);
		logger.warn({ src: "x-autonomy", error: message }, "X autonomy tick failed");
		await logXAutonomy(runtime, task, { ok: false, error: message, viewerScreenName: state.viewerScreenName });
		throw err;
	} finally {
		await updateXAutonomyTask(runtime, task, state);
	}

	await logXAutonomy(runtime, task, {
		ok: true,
		viewerScreenName: state.viewerScreenName,
		writeEnabled: settings.writeEnabled,
		discoveryEnabled: settings.discoveryEnabled,
		proactiveEngagementEnabled: settings.proactiveEngagementEnabled,
		handledCount: state.handled.length,
		handled: state.handled,
	});
	logger.info(
		{
			src: "x-autonomy",
			handledCount: state.handled.length,
			writeEnabled: settings.writeEnabled,
			discoveryEnabled: settings.discoveryEnabled,
			proactiveEngagementEnabled: settings.proactiveEngagementEnabled,
		},
		"X autonomy tick complete",
	);
}

export class XAutonomyService extends Service {
	static serviceType = "x_autonomy";
	static serviceName = "X Autonomy";

	static async start(runtime: IAgentRuntime): Promise<XAutonomyService> {
		const service = new XAutonomyService(runtime);
		service.register(runtime);
		await ensureXAutonomyTask(runtime);
		return service;
	}

	private register(runtime: IAgentRuntime): void {
		if (runtime.getTaskWorker(X_AUTONOMY_TASK_NAME)) return;
		runtime.registerTaskWorker({
			name: X_AUTONOMY_TASK_NAME,
			execute: async (rt, _options, task) => {
				await executeXAutonomyTask(rt, task);
				return undefined;
			},
		});
	}

	async stop(): Promise<void> {}

	get capabilityDescription(): string {
		return "Autonomously handles X notifications and discovers algorithm-fit conversations";
	}
}

function configuredStatusString(
	runtime: IAgentRuntime,
	opts: Record<string, unknown> | undefined,
	keys: string[],
	settingKey: string,
	defaultValue: string,
): string {
	const option = pickString(opts, keys)?.trim();
	if (option) return option;
	const setting = pickSetting(runtime, settingKey)?.trim();
	return setting || defaultValue;
}

/** True if `candidate` matches (or substantially overlaps) one of the agent's
 *  recent posts, used to skip status posts X would reject as duplicates (187),
 *  rather than wasting the attempt on the duplicate wall. */
function isDuplicateStatus(candidate: string, recent: string[]): boolean {
	const norm = (s: string) => s.toLowerCase().replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
	const c = norm(candidate);
	if (c.length === 0) return false;
	return recent.some((r) => {
		const rn = norm(r);
		if (rn.length === 0) return false;
		if (rn === c) return true;
		return c.length > 24 && rn.length > 24 && (rn.includes(c) || c.includes(rn));
	});
}

async function postGeneratedXStatus(
	runtime: IAgentRuntime,
	client: XClient,
	callback: HandlerCallback | undefined,
	actionName: string,
	lane: XStatusLane,
	context: string,
	forceWrite = false,
): Promise<ActionResult> {
	try {
		const writeAllowed = forceWrite || readBooleanSetting(runtime, "X_AUTONOMY_WRITE", true);
		const viewer = await client.viewer();
		// Recent posts: feed them to the generator so it varies, and dedup against
		// them before posting; skipping repeats instead of hitting X's duplicate
		// (187) wall, which was rejecting the bulk of status attempts.
		const recentStatusTexts = (await client.getUserTweets(viewer.userId, 12).catch(() => []))
			.map((t) => t.text)
			.filter((t): t is string => typeof t === "string" && t.length > 0);
		const decision = await decideXStatusPost(runtime, {
			viewerScreenName: viewer.screenName,
			lane,
			context,
			recentReplyTexts: recentStatusTexts,
		});
		const text = sanitizeXOutputText(decision.text, 260);
		if (!readModelBoolean(decision.should_post) || text.length === 0) {
			const fallback = sanitizeXOutputText(fallbackXStatusText(lane, context), 260);
			if (fallback.length === 0) {
				const reason = decision.reason ?? "model declined";
				logger.info({ src: "x-tweets", actionName, lane, reason }, "generated X status skipped");
				await emit(callback, `${actionName} skipped: ${reason}`, actionName);
				return { success: true, text: `${actionName} skipped: ${reason}`, values: { skipped: true, reason }, continueChain: false };
			}
			if (!writeAllowed) {
				logger.info({ src: "x-tweets", actionName, lane, text: fallback }, "generated X status fallback dry run");
				await emit(callback, `${actionName} dry run: ${fallback}`, actionName);
				return { success: true, text: fallback, values: { dryRun: true, fallback: true }, continueChain: false };
			}
			if (isDuplicateStatus(fallback, recentStatusTexts)) {
				logger.info({ src: "x-tweets", actionName, lane }, "generated X status skipped: fallback duplicates a recent post");
				await emit(callback, `${actionName} skipped: duplicate of a recent post`, actionName);
				return { success: true, text: `${actionName} skipped: duplicate`, values: { skipped: true, reason: "duplicate" }, continueChain: false };
			}
			const fallbackResult = await client.tweet(fallback);
			if (!fallbackResult.success) {
				const error = fallbackResult.error ?? "unknown";
				logger.warn({ src: "x-tweets", actionName, lane, error }, "generated X status fallback post failed");
				await emit(callback, `${actionName} failed: ${error}`, actionName);
				return { success: false, error, continueChain: false };
			}
			if (fallbackResult.tweetId) {
				recordOutboundTweet(runtime, fallbackResult.tweetId, fallback);
			}
			const fallbackUrl = fallbackResult.url ?? `https://x.com/i/web/status/${fallbackResult.tweetId}`;
			logger.info({ src: "x-tweets", actionName, lane, tweetId: fallbackResult.tweetId, url: fallbackUrl }, "generated X status fallback posted");
			await emit(callback, `Posted: ${fallbackUrl}`, actionName);
			return { success: true, text: `Posted: ${fallbackUrl}`, data: { tweetId: fallbackResult.tweetId, url: fallbackUrl, statusText: fallback, fallback: true }, continueChain: false };
		}
		if (!writeAllowed) {
			logger.info({ src: "x-tweets", actionName, lane, text }, "generated X status dry run");
			await emit(callback, `${actionName} dry run: ${text}`, actionName);
			return { success: true, text, values: { dryRun: true }, continueChain: false };
		}
		if (isDuplicateStatus(text, recentStatusTexts)) {
			logger.info({ src: "x-tweets", actionName, lane }, "generated X status skipped: duplicates a recent post");
			await emit(callback, `${actionName} skipped: duplicate of a recent post`, actionName);
			return { success: true, text: `${actionName} skipped: duplicate`, values: { skipped: true, reason: "duplicate" }, continueChain: false };
		}
		const result = await client.tweet(text);
		if (!result.success) {
			const error = result.error ?? "unknown";
			logger.warn({ src: "x-tweets", actionName, lane, error }, "generated X status post failed");
			await emit(callback, `${actionName} failed: ${error}`, actionName);
			return { success: false, error, continueChain: false };
		}
		if (result.tweetId) {
			recordOutboundTweet(runtime, result.tweetId, text);
		}
		const url = result.url ?? `https://x.com/i/web/status/${result.tweetId}`;
		logger.info({ src: "x-tweets", actionName, lane, tweetId: result.tweetId, url }, "generated X status posted");
		await emit(callback, `Posted: ${url}`, actionName);
		return { success: true, text: `Posted: ${url}`, data: { tweetId: result.tweetId, url, statusText: text }, continueChain: false };
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		logger.warn({ src: "x-tweets", actionName, lane, error }, "generated X status failed");
		await emit(callback, `${actionName} failed: ${error}`, actionName);
		return { success: false, error, continueChain: false };
	}
}

// ── X_POST ──────────────────────────────────────────────────────────────────

const postHandler: Handler = async (runtime, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const text = pickString(opts, ["text", "content", "tweet", "message"]);
	const mediaUrls = pickMediaUrls(opts);
	if (text && text.length > 280) {
		logger.info({ src: "x-tweets", len: text.length }, "long-form tweet (>280 chars)");
	}
	return withClient(runtime, callback, "X_POST", async (client) => {
		if (!text) {
			const context = await buildTokenStatusContext(runtime);
			return postGeneratedXStatus(runtime, client, callback, "X_POST", "token_status", context, true);
		}
		let mediaIds: string[] = [];
		if (mediaUrls.length > 0) {
			const upload = await resolveAndUploadMedia(client, mediaUrls);
			mediaIds = upload.mediaIds;
			if (upload.errors.length > 0) {
				logger.warn({ src: "x-tweets", action: "X_POST", errors: upload.errors }, "some media uploads failed; posting with what attached");
			}
		} else if (shouldAttachImage(text, runtime.actions ?? [])) {
			const imgAction = (runtime.actions ?? []).find((a) => a.name === "GENERATE_IMAGE");
			if (imgAction) {
				try {
					const imgResult = await imgAction.handler(
						runtime,
						_m,
						undefined,
						{ prompt: imagePromptFromDraft(text) },
						async () => [],
					);
					const imageUrl: string =
						(imgResult as Record<string, unknown> | undefined)?.data &&
						typeof ((imgResult as Record<string, unknown>).data as Record<string, unknown>)?.imageUrl === "string"
							? String(((imgResult as Record<string, unknown>).data as Record<string, unknown>).imageUrl)
							: (imgResult as Record<string, unknown> | undefined)?.values &&
							  typeof ((imgResult as Record<string, unknown>).values as Record<string, unknown>)?.imageUrl === "string"
							? String(((imgResult as Record<string, unknown>).values as Record<string, unknown>).imageUrl)
							: "";
					if (imageUrl) {
						const upload = await resolveAndUploadMedia(client, [imageUrl]);
						mediaIds = upload.mediaIds;
						if (upload.errors.length > 0) {
							logger.warn({ src: "x-tweets", action: "X_POST", errors: upload.errors }, "generated image upload failed; posting text-only");
							mediaIds = [];
						}
					}
				} catch {
					mediaIds = [];
				}
			}
		}
		const r = await client.tweet(text, mediaIds.length > 0 ? { mediaIds } : {});
		if (!r.success) {
			await emit(callback, `X_POST failed: ${r.error ?? "unknown"}`, "X_POST");
			return { success: false, error: r.error };
		}
		if (r.tweetId) {
			recordOutboundTweet(runtime, r.tweetId, text);
		}
		const url = r.url ?? `https://x.com/i/web/status/${r.tweetId}`;
		logger.info({ src: "x-tweets", tweetId: r.tweetId, url, mediaCount: mediaIds.length }, "X_POST sent");
		const summary = mediaIds.length > 0
			? `Posted (${mediaIds.length} media attached): ${url}`
			: `Posted: ${url}`;
		await emit(callback, summary, "X_POST");
		return { success: true, tweetId: r.tweetId, url, mediaIds };
	});
};

export const xPostAction: Action = {
	name: "X_POST",
	similes: ["TWEET", "POST_TO_X", "POST_TWITTER", "TWEET_OUT"],
	description:
		"Post a new public tweet/status on X as the logged-in account. Use immediately when Dexploarer says to post/tweet from any connected channel. If exact text is provided, publish it; if no text is provided, generate and publish a Detour Squirrel token/project status. Pass `mediaUrls` (or `imageUrl`/`videoUrl`), typically the hosted URL returned by GENERATE_IMAGE / GENERATE_VIDEO, to attach images/videos to the tweet; the handler downloads, uploads to X's chunked endpoint, and attaches the resulting media_ids. X caps at 4 images / 1 GIF / 1 video per tweet. No extra confirmation is required for owner commands when X write is configured. Returns the posted URL.",
	descriptionCompressed:
		"post/tweet public X status now; supports mediaUrls (image/video) from generation actions; owner command is confirmation.",
	validate: alwaysValid,
	handler: postHandler,
	examples: [
		[
			{ name: "{{user}}", content: { text: "tweet this: agents with permissions should act, not ask for a permission slip" } },
			{ name: "{{agent}}", content: { text: "Posted.", actions: ["X_POST"] } },
		],
		[
			{ name: "{{user}}", content: { text: "post a status on X from tg chat" } },
			{ name: "{{agent}}", content: { text: "Posted a project/status hit.", actions: ["X_POST"] } },
		],
		[
			{ name: "{{user}}", content: { text: "post that image we just generated" } },
			{ name: "{{agent}}", content: { text: "Posting with the image attached.", actions: ["X_POST"] } },
		],
	],
	parameters: [
		{ name: "text", description: "Tweet body. Optional for owner status commands; missing text generates a Detour Squirrel token/project status.", required: false, schema: { type: "string" as const } },
		{ name: "mediaUrls", description: "Optional array of hosted image/video URLs (e.g. from GENERATE_IMAGE / GENERATE_VIDEO). Bytes are fetched, uploaded to X's chunked endpoint, and attached as media_ids. Cap 4. Accepts `imageUrl` / `videoUrl` aliases for single-URL convenience.", required: false, schema: { type: "array" as const, items: { type: "string" as const } } },
	],
} as Action;

// ── X_POST_THREAD ────────────────────────────────────────────────────────────

function threadSegmentsFromOptions(options: Record<string, unknown>): string[] {
	const raw = options.segments;
	if (Array.isArray(raw)) return raw.map((s) => String(s)).filter((s) => s.trim().length > 0);
	const text = typeof options.text === "string" ? options.text : "";
	return text.split(/\n\s*\n+/).map((s) => s.trim()).filter((s) => s.length > 0);
}

const threadHandler: Handler = async (runtime, _m, _s, options, callback) => {
	const opts = (options as Record<string, unknown> | undefined) ?? {};
	const segments = threadSegmentsFromOptions(opts);
	return withClient(runtime, callback, "X_POST_THREAD", async (client) => {
		if (segments.length < 2) {
			const text = pickString(opts, ["text", "content", "tweet", "message"]) ?? segments[0] ?? "";
			if (!text) return missing("X_POST_THREAD", "segments", callback);
			const r = await client.tweet(text);
			if (!r.success) {
				await emit(callback, `X_POST_THREAD failed: ${r.error ?? "unknown"}`, "X_POST_THREAD");
				return { success: false, error: r.error };
			}
			if (r.tweetId) recordOutboundTweet(runtime, r.tweetId, text);
			const url = r.url ?? `https://x.com/i/web/status/${r.tweetId}`;
			await emit(callback, `Posted: ${url}`, "X_POST_THREAD");
			return { success: true, tweetId: r.tweetId, url };
		}
		const res = await client.postThread(segments);
		if (!res.success) {
			const partial = res.tweetIds.length > 0
				? ` (${res.tweetIds.length} segment(s) posted before failure)`
				: "";
			const errMsg = `X_POST_THREAD failed at segment ${res.tweetIds.length + 1}${partial}: ${res.error ?? "unknown"}`;
			await emit(callback, errMsg, "X_POST_THREAD");
			const firstUrl = res.tweetIds[0]
				? `https://x.com/i/web/status/${res.tweetIds[0]}`
				: undefined;
			return { success: false, error: res.error, tweetIds: res.tweetIds, url: firstUrl };
		}
		for (const [i, id] of res.tweetIds.entries()) {
			recordOutboundTweet(runtime, id, segments[i] ?? "");
		}
		logger.info({ src: "x-tweets", tweetIds: res.tweetIds, url: res.url }, "X_POST_THREAD posted");
		await emit(callback, `Thread posted (${res.tweetIds.length} parts): ${res.url}`, "X_POST_THREAD");
		return { success: true, tweetIds: res.tweetIds, url: res.url };
	});
};

export const xPostThreadAction: Action = {
	name: "X_POST_THREAD",
	similes: ["THREAD_TWEET", "POST_THREAD", "TWEET_THREAD", "X_THREAD"],
	description:
		"Post a multi-part thread on X. Pass `segments` (string array) for explicit parts, or pass `text` with blank-line separators. Segment 0 becomes the original tweet; each later segment is a reply to the previous one. Use X_POST_THREAD when a take needs more than one post to land. One strong opener, each reply earns the next. Do not pad. Returns the URL of the first tweet in the thread.",
	descriptionCompressed:
		"post multi-part X thread via chained replies; segments array or blank-line-separated text; returns first tweet URL.",
	validate: alwaysValid,
	handler: threadHandler,
	examples: [
		[
			{ name: "{{user}}", content: { text: "thread this out: here is why the outage was actually about yaml" } },
			{ name: "{{agent}}", content: { text: "Threading it.", actions: ["X_POST_THREAD"] } },
		],
		[
			{ name: "{{user}}", content: { text: "post a 3-part thread on why agents need permissions not chatbots" } },
			{ name: "{{agent}}", content: { text: "Posted thread.", actions: ["X_POST_THREAD"] } },
		],
	],
	parameters: [
		{ name: "segments", description: "Array of thread parts. Each becomes a separate tweet (first is original, rest are replies).", required: false, schema: { type: "array" as const, items: { type: "string" as const } } },
		{ name: "text", description: "Alternatively, pass a single string with parts separated by blank lines.", required: false, schema: { type: "string" as const } },
	],
} as Action;

// ── X_POST_DETOUR_STATUS ────────────────────────────────────────────────────

const detourStatusHandler: Handler = async (runtime, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const repo = configuredStatusString(runtime, opts, ["repo", "repoRef", "repository"], "X_STATUS_DETOUR_REPO", X_STATUS_DEFAULT_DETOUR_REPO);
	return withClient(runtime, callback, "X_POST_DETOUR_STATUS", async (client) => {
		const context = await buildDetourProjectStatusContext(runtime, repo);
		return postGeneratedXStatus(runtime, client, callback, "X_POST_DETOUR_STATUS", "detour_project", context, true);
	});
};

export const xPostDetourStatusAction: Action = {
	name: "X_POST_DETOUR_STATUS",
	similes: ["POST_DETOUR_STATUS", "POST_DETOUR_PROJECT_UPDATE", "TWEET_DETOUR_STATUS", "POST_DETOUR_PROGRESS"],
	description:
		"Fetch GitHub context for Detour's repository, compose one public-safe project status update, " +
		"and post it to X as the logged-in account. Use immediately for Dexploarer owner commands to post a project/status update; do not ask for another confirmation.",
	descriptionCompressed:
		"generate and post Detour project X status now; owner command is confirmation.",
	validate: alwaysValid,
	handler: detourStatusHandler,
	examples: [
		[
			{ name: "{{user}}", content: { text: "post a Detour project status on X" } },
			{ name: "{{agent}}", content: { text: "Posted a Detour status.", actions: ["X_POST_DETOUR_STATUS"] } },
		],
	],
	parameters: [
		{ name: "repo", description: "Optional owner/repo. Defaults to Dexploarer/detour.", required: false, schema: { type: "string" as const } },
	],
} as Action;

// ── X_POST_TOKEN_STATUS ────────────────────────────────────────────────────

const tokenStatusHandler: Handler = async (runtime, _m, _s, _options, callback) => {
	return withClient(runtime, callback, "X_POST_TOKEN_STATUS", async (client) => {
		const context = await buildTokenStatusContext(runtime);
		return postGeneratedXStatus(runtime, client, callback, "X_POST_TOKEN_STATUS", "token_status", context, true);
	});
};

export const xPostTokenStatusAction: Action = {
	name: "X_POST_TOKEN_STATUS",
	similes: ["POST_TOKEN_STATUS", "POST_TOKEN_SHILL", "TWEET_TOKEN_STATUS", "SHILL_TOKEN", "POST_CA_UPDATE"],
	description:
		"Compose and post one public-safe Detour Squirrel token/project status using the configured CA and project utility. Use immediately when Dexploarer says to post/shill/tweet a status from any connected channel. No extra confirmation is required for owner commands when X write is configured.",
	descriptionCompressed:
		"generate and post Detour Squirrel token/project X status now; owner command is confirmation.",
	validate: alwaysValid,
	handler: tokenStatusHandler,
	examples: [
		[
			{ name: "{{user}}", content: { text: "post a status on x from tg chat" } },
			{ name: "{{agent}}", content: { text: "Posted a token/project status.", actions: ["X_POST_TOKEN_STATUS"] } },
		],
		[
			{ name: "{{user}}", content: { text: "shill the token on X" } },
			{ name: "{{agent}}", content: { text: "Posted a token shill.", actions: ["X_POST_TOKEN_STATUS"] } },
		],
	],
	parameters: [],
} as Action;

// ── X_POST_DEXPLOARER_STATUS ────────────────────────────────────────────────

const dexploarerStatusHandler: Handler = async (runtime, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const developer = configuredStatusString(runtime, opts, ["developer", "login", "username"], "X_STATUS_DEVELOPER_LOGIN", X_STATUS_DEFAULT_DEVELOPER_LOGIN);
	return withClient(runtime, callback, "X_POST_DEXPLOARER_STATUS", async (client) => {
		const context = await buildDexploarerActivityContext(runtime, developer);
		return postGeneratedXStatus(runtime, client, callback, "X_POST_DEXPLOARER_STATUS", "dexploarer_activity", context, true);
	});
};

export const xPostDexploarerStatusAction: Action = {
	name: "X_POST_DEXPLOARER_STATUS",
	similes: ["POST_DEVELOPER_STATUS", "POST_DEXPLOARER_ACTIVITY", "TWEET_DEXPLOARER_STATUS"],
	description:
		"Fetch public GitHub context for Dexploarer's recent activity, compose one public-safe builder status update, " +
		"and post it to X as the logged-in account. Use immediately for owner commands; do not ask for another confirmation.",
	descriptionCompressed:
		"generate and post Dexploarer builder/activity X status now; owner command is confirmation.",
	validate: alwaysValid,
	handler: dexploarerStatusHandler,
	examples: [],
	parameters: [
		{ name: "developer", description: "Optional GitHub username. Defaults to Dexploarer.", required: false, schema: { type: "string" as const } },
	],
} as Action;

// ── X_REPLY ─────────────────────────────────────────────────────────────────

const replyHandler: Handler = async (runtime, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const text = pickString(opts, ["text", "content", "reply", "message"]);
	const replyToTweetId = pickString(opts, ["replyToTweetId", "tweetId", "inReplyTo", "parentId"]);
	const mediaUrls = pickMediaUrls(opts);
	if (!text) return missing("X_REPLY", "text", callback);
	if (!replyToTweetId) return missing("X_REPLY", "replyToTweetId", callback);

	return withClient(runtime, callback, "X_REPLY", async (client) => {
		// Self-action guard: refuse to reply to a tweet the agent posted.
		try {
			const [self, target] = await Promise.all([selfViewer(client), client.getTweet(replyToTweetId)]);
			if (isSelfTweet(target, self)) {
				const msg = `Refusing to reply to ${replyToTweetId}: it was authored by @${self?.screenName} (self). Self-action guard.`;
				logger.info({ src: "x-tweets", tweetId: replyToTweetId }, msg);
				await emit(callback, msg, "X_REPLY");
				return { success: false, error: msg };
			}
		} catch { /* fail-open on lookup error */ }
		let mediaIds: string[] = [];
		if (mediaUrls.length > 0) {
			const upload = await resolveAndUploadMedia(client, mediaUrls);
			mediaIds = upload.mediaIds;
			if (upload.errors.length > 0) {
				logger.warn({ src: "x-tweets", action: "X_REPLY", errors: upload.errors }, "some media uploads failed; replying with what attached");
			}
		}
		const r = await client.reply(text, replyToTweetId, mediaIds.length > 0 ? { mediaIds } : {});
		if (!r.success) {
			await emit(callback, `X_REPLY failed: ${r.error ?? "unknown"}`, "X_REPLY");
			return { success: false, error: r.error };
		}
		if (r.tweetId) {
			recordOutboundTweet(runtime, r.tweetId, text, replyToTweetId);
		}
		const url = r.url ?? `https://x.com/i/web/status/${r.tweetId}`;
		logger.info({ src: "x-tweets", tweetId: r.tweetId, replyTo: replyToTweetId, mediaCount: mediaIds.length }, "X_REPLY sent");
		const summary = mediaIds.length > 0
			? `Replied (${mediaIds.length} media attached): ${url}`
			: `Replied: ${url}`;
		await emit(callback, summary, "X_REPLY");
		return { success: true, tweetId: r.tweetId, url, mediaIds };
	});
};

export const xReplyAction: Action = {
	name: "X_REPLY",
	similes: ["REPLY_TO_TWEET", "REPLY_TO_X", "TWEET_REPLY"],
	description:
		"Reply to a tweet by its numeric ID. Use for specific, useful conversation, especially direct " +
		"mentions and replies to your posts; X's open-source ranking pipeline predicts reply and downstream " +
		"conversation probability as core engagement signals. Pass `mediaUrls` (or `imageUrl`/`videoUrl`) to " +
		"attach an image/video, typically the hosted URL returned by GENERATE_IMAGE or GENERATE_VIDEO.",
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
		{
			name: "mediaUrls",
			description: "Optional array of hosted image/video URLs to attach. Cap 4. Use the hosted URL from GENERATE_IMAGE / GENERATE_VIDEO action results.",
			required: false,
			schema: { type: "array" as const, items: { type: "string" as const } },
		},
	],
} as Action;

// ── X_LIKE ──────────────────────────────────────────────────────────────────

const likeHandler: Handler = async (runtime, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const tweetId = pickString(opts, ["tweetId", "id"]);
	if (!tweetId) return missing("X_LIKE", "tweetId", callback);
	return withClient(runtime, callback, "X_LIKE", async (client) => {
		try {
			const [self, target] = await Promise.all([selfViewer(client), client.getTweet(tweetId)]);
			if (isSelfTweet(target, self)) {
				const msg = `Refusing to like ${tweetId}: tweet authored by @${self?.screenName} (self). Self-action guard.`;
				await emit(callback, msg, "X_LIKE");
				return { success: false, error: msg };
			}
		} catch { /* fail-open */ }
		const r = await client.like(tweetId);
		await emit(callback, r.success ? `Liked ${tweetId}` : `X_LIKE failed: ${r.error}`, "X_LIKE");
		return r;
	});
};

export const xLikeAction: Action = {
	name: "X_LIKE",
	similes: ["LIKE_TWEET", "FAVORITE_TWEET", "HEART_TWEET"],
	description:
		"Like a tweet by ID. Use as lightweight acknowledgement for relevant posts when a reply would add noise.",
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
		try {
			const [self, target] = await Promise.all([selfViewer(client), client.getTweet(tweetId)]);
			if (isSelfTweet(target, self)) {
				const msg = `Refusing to retweet ${tweetId}: it's your own tweet (@${self?.screenName}). Self-action guard.`;
				await emit(callback, msg, "X_RETWEET");
				return { success: false, error: msg };
			}
		} catch { /* fail-open */ }
		const r = await client.retweet(tweetId);
		await emit(callback, r.success ? `Retweeted ${tweetId} → ${r.url}` : `X_RETWEET failed: ${r.error}`, "X_RETWEET");
		return r;
	});
};

export const xRetweetAction: Action = {
	name: "X_RETWEET",
	similes: ["RETWEET", "RT", "AMPLIFY_TWEET"],
	description:
		"Retweet a post. Use sparingly for strong in-orbit content because it broadcasts to followers.",
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
	description: "Bookmark a tweet for private saving and future context.",
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
		// Self-guard: can't follow yourself.
		try {
			const self = await selfViewer(client);
			if (isSelfHandle(screenName, self) || isSelfUserId(userId, self)) {
				const msg = `Refusing to follow self (@${self?.screenName}). Self-action guard.`;
				await emit(callback, msg, "X_FOLLOW");
				return { success: false, error: msg };
			}
		} catch { /* fail-open */ }
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
		"List recent tweets by @handle or user ID. Use to surface posts to engage with, especially " +
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
		"Search X for tweets matching a query. Find conversations to engage in by searching for " +
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

// ── X_WHOAMI ────────────────────────────────────────────────────────────────

const whoAmIHandler: Handler = async (runtime, _m, _s, _options, callback) => {
	return withClient(runtime, callback, "X_WHOAMI", async (client) => {
		const self = await selfViewer(client);
		if (!self) {
			await emit(callback, "X_WHOAMI: could not resolve the authenticated account.", "X_WHOAMI");
			return { success: false, error: "viewer lookup failed" };
		}
		await emit(callback, `Authenticated on X as @${self.screenName} (id ${self.userId}).`, "X_WHOAMI");
		return { success: true, user: self };
	});
};

export const xWhoAmIAction: Action = {
	name: "X_WHOAMI",
	similes: ["X_ME", "WHO_AM_I_ON_X", "X_SELF", "X_ACCOUNT"],
	description: "Report which X account the agent is currently signed in as (handle + numeric id).",
	validate: alwaysValid,
	handler: whoAmIHandler,
	examples: [],
	parameters: [],
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
		"Read recent notifications (mentions, replies, likes, follows). Pair with X_REPLY when a direct " +
		"mention or reply clearly deserves a useful response.",
	validate: alwaysValid,
	handler: notificationsHandler,
	examples: [],
	parameters: [],
} as Action;

// ── X_DISCOVER_PEOPLE ───────────────────────────────────────────────────────

const discoverPeopleHandler: Handler = async (runtime, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const explicitQuery = pickString(opts, ["query", "q", "queries", "search"]);
	const limit = Math.max(1, Math.min(20, pickNumber(opts, ["limit", "count"]) ?? 10));
	const queries = explicitQuery
		? splitList(explicitQuery)
		: readListSetting(runtime, "X_AUTONOMY_DISCOVERY_QUERIES", X_AUTONOMY_DEFAULT_DISCOVERY_QUERIES);
	return withClient(runtime, callback, "X_DISCOVER_PEOPLE", async (client) => {
		const viewer = await client.viewer();
		const candidates = await discoverXCandidates(client, {
			viewerScreenName: viewer.screenName,
			queries,
			seen: new Set(),
			limit,
		});
		const summary = candidates
			.slice(0, X_AUTONOMY_LIMITS.maxDiscoveryPerTick.max)
			.map((candidate) => {
				const tweet = candidate.tweet;
				const author = tweet.authorScreenName ? `@${tweet.authorScreenName}` : "@?";
				return `• ${author} score ${candidate.score}: ${compactText(tweet.text, 120)} (${tweet.url})`;
			})
			.join("\n");
		await emit(
			callback,
			candidates.length > 0
				? `Algorithm-fit X candidates for ${queries.join(", ")}:\n${summary}`
				: `No algorithm-fit X candidates found for ${queries.join(", ")}.`,
			"X_DISCOVER_PEOPLE",
		);
		return { success: true, queries, candidates };
	});
};

export const xDiscoverPeopleAction: Action = {
	name: "X_DISCOVER_PEOPLE",
	similes: ["FIND_X_PEOPLE", "DISCOVER_X_CONVERSATIONS", "FIND_X_THREADS", "X_GROWTH_DISCOVERY"],
	description:
		"Search X across configured topics, rank recent conversation candidates with the open-source X " +
		"pipeline heuristics, and return authors/posts worth replying to, liking, or following. Read-only.",
	validate: alwaysValid,
	handler: discoverPeopleHandler,
	examples: [],
	parameters: [
		{ name: "query", description: "Optional comma-separated X search queries. Defaults to X_AUTONOMY_DISCOVERY_QUERIES.", required: false, schema: { type: "string" as const } },
		{ name: "limit", description: "Max candidates to return (default 10).", required: false, schema: { type: "number" as const } },
	],
} as Action;

// ── X_ALGORITHM_PLAYBOOK ────────────────────────────────────────────────────

const algorithmPlaybookHandler: Handler = async (runtime, _m, _s, _options, callback) => {
	const settings = {
		autonomyEnabled: readBooleanSetting(runtime, "X_AUTONOMY_ENABLED", true),
		writeEnabled: readBooleanSetting(runtime, "X_AUTONOMY_WRITE", true),
		statusPostingEnabled: readBooleanSetting(runtime, "X_AUTONOMY_POST_STATUS_ENABLED", true),
		discoveryEnabled: readBooleanSetting(runtime, "X_AUTONOMY_DISCOVERY_ENABLED", true),
		proactiveEngagementEnabled: readBooleanSetting(runtime, "X_AUTONOMY_PROACTIVE_ENGAGEMENT_ENABLED", false),
		followEnabled: readBooleanSetting(runtime, "X_AUTONOMY_FOLLOW_ENABLED", false),
		discoveryQueries: readListSetting(runtime, "X_AUTONOMY_DISCOVERY_QUERIES", X_AUTONOMY_DEFAULT_DISCOVERY_QUERIES),
	};
	const rendered = [
		X_ALGORITHM_PLAYBOOK,
		"",
		"Current X autonomy settings:",
		`autonomyEnabled: ${settings.autonomyEnabled}`,
		`writeEnabled: ${settings.writeEnabled}`,
		`statusPostingEnabled: ${settings.statusPostingEnabled}`,
		`discoveryEnabled: ${settings.discoveryEnabled}`,
		`proactiveEngagementEnabled: ${settings.proactiveEngagementEnabled}`,
		`followEnabled: ${settings.followEnabled}`,
		`discoveryQueries: ${settings.discoveryQueries.join(", ")}`,
	].join("\n");
	await emit(callback, rendered, "X_ALGORITHM_PLAYBOOK");
	return { success: true, playbook: X_ALGORITHM_PLAYBOOK, settings };
};

// Eligible ONLY when the user is actually asking about X/Twitter growth, reach,
// ranking, or strategy; never for general chat. Without this gate the planner
// (especially weaker models) over-selects this action for unrelated turns like
// greetings or "/help", hijacking ordinary replies.
const PLAYBOOK_TRIGGER_TERMS = ["algorithm", "playbook", "for you feed", "for-you feed", "ranking", "go viral", "virality", "reach"];
const PLAYBOOK_CONTEXT_TERMS = ["x ", "twitter", "tweet", "post", "feed", "timeline", "follower", "audience", "engagement", "grow", "growth"];
const PLAYBOOK_STRATEGY_RE = /\b(strateg|grow|growth|reach|rank|viral|engagement|best practice|how (do|to|should|can))\b/;

const algorithmPlaybookValidate: Action["validate"] = async (_runtime, message) => {
	const text = typeof message?.content?.text === "string" ? message.content.text.toLowerCase() : "";
	if (!text) return false;
	if (PLAYBOOK_TRIGGER_TERMS.some((term) => text.includes(term))) return true;
	return PLAYBOOK_CONTEXT_TERMS.some((term) => text.includes(term)) && PLAYBOOK_STRATEGY_RE.test(text);
};

export const xAlgorithmPlaybookAction: Action = {
	name: "X_ALGORITHM_PLAYBOOK",
	similes: ["X_GROWTH_PLAYBOOK", "X_ALGO_PLAYBOOK", "TWITTER_ALGORITHM_PLAYBOOK"],
	description:
		"Return the agent's X For You algorithm strategy (per xai-org/x-algorithm), source links, guardrails, and autonomy flags. Use ONLY when the user explicitly asks about X/Twitter growth, reach, ranking, or strategy. Never use for general chat or non-X requests.",
	validate: algorithmPlaybookValidate,
	handler: algorithmPlaybookHandler,
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
		"notifications, GitHub-backed status posts, token/project status posts, algorithm playbook, and algorithm-fit discovery. Reads X_AUTH_TOKEN + X_CT0 " +
		"from the vault. Autonomy handles direct notifications by default and performs read-only " +
		"discovery unless proactive public engagement is explicitly enabled.",
	actions: [
		xPostAction,
		xPostThreadAction,
		xPostDetourStatusAction,
		xPostTokenStatusAction,
		xPostDexploarerStatusAction,
		xReplyAction,
		xNotificationsAction,
		xAlgorithmPlaybookAction,
		xDiscoverPeopleAction,
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
		xWhoAmIAction,
	],
	services: [XAutonomyService],
};

export default xTweetsPlugin;
export { XClient } from "./x-client";
export type { XCookies, XPostResult, XClientOptions, XViewer, XTweetSummary, XUserSummary, XSearchOptions, XNotification } from "./x-client";
