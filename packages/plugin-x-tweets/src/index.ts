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
	type Handler,
	type HandlerCallback,
	type IAgentRuntime,
	logger,
	ModelType,
	parseToonKeyValue,
	type Plugin,
	Service,
	type Task,
	type TaskMetadata,
	type UUID,
} from "@elizaos/core";
import { XClient, type XTweetSummary } from "./x-client";

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

function pickString(opts: Record<string, unknown> | undefined, keys: string[]): string | undefined {
	if (!opts) return undefined;
	// 1. canonical eliza contract
	const params = paramsBag(opts);
	for (const k of keys) {
		const v = params[k];
		if (typeof v === "string" && v.length > 0) return v;
	}
	// 2. top-level (imperative callers / direct invocations)
	for (const k of keys) {
		const v = opts[k];
		if (typeof v === "string" && v.length > 0) return v;
	}
	// 3. defensive deep walk — handles eliza versions that nest params
	// under `options.<ACTION>`, `options.arguments`, etc.
	const queue: Record<string, unknown>[] = [opts];
	const seen = new Set<unknown>();
	while (queue.length > 0) {
		const cur = queue.shift()!;
		if (seen.has(cur)) continue;
		seen.add(cur);
		for (const k of keys) {
			const v = cur[k];
			if (typeof v === "string" && v.length > 0) return v;
		}
		for (const v of Object.values(cur)) {
			if (v && typeof v === "object" && !Array.isArray(v)) queue.push(v as Record<string, unknown>);
		}
	}
	return undefined;
}

function pickNumber(opts: Record<string, unknown> | undefined, keys: string[]): number | undefined {
	if (!opts) return undefined;
	const params = paramsBag(opts);
	for (const k of keys) {
		const v = params[k];
		if (typeof v === "number" && Number.isFinite(v)) return v;
		if (typeof v === "string" && v.length > 0 && Number.isFinite(Number(v))) return Number(v);
	}
	for (const k of keys) {
		const v = opts[k];
		if (typeof v === "number" && Number.isFinite(v)) return v;
		if (typeof v === "string" && v.length > 0 && Number.isFinite(Number(v))) return Number(v);
	}
	const queue: Record<string, unknown>[] = [opts];
	const seen = new Set<unknown>();
	while (queue.length > 0) {
		const cur = queue.shift()!;
		if (seen.has(cur)) continue;
		seen.add(cur);
		for (const k of keys) {
			const v = cur[k];
			if (typeof v === "number" && Number.isFinite(v)) return v;
			if (typeof v === "string" && v.length > 0 && Number.isFinite(Number(v))) return Number(v);
		}
		for (const v of Object.values(cur)) {
			if (v && typeof v === "object" && !Array.isArray(v)) queue.push(v as Record<string, unknown>);
		}
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

const X_AUTONOMY_TASK_NAME = "X_AUTONOMY";
const X_AUTONOMY_TASK_TAGS = ["queue", "repeat", "x-autonomy"];
const X_AUTONOMY_DEFAULT_INTERVAL_MS = 60_000;
const X_AUTONOMY_DEFAULT_STATUS_INTERVAL_MS = 2 * 60 * 60 * 1000;
const X_AUTONOMY_DEFAULT_DISCOVERY_INTERVAL_MS = 10 * 60_000;
const X_AUTONOMY_SEEN_LIMIT = 500;
const X_AUTONOMY_DEFAULT_DISCOVERY_QUERIES = [
	"elizaOS",
	"Dexploarer",
	"ai agents",
	"autonomous agents",
	"agent framework",
	"personal AI",
	"developer tools",
];

const X_ALGORITHM_PLAYBOOK = [
	"X algorithm playbook:",
	"- Treat growth as a candidate pipeline: discover relevant conversations, filter low-quality or unsafe candidates, rank by likely useful engagement, then diversify authors.",
	"- Use the same broad signal families X exposes: follows, likes, replies, reposts, quotes, bookmarks, clicks, video watch, profile clicks, shares, dwell, not-interested, blocks, mutes, and reports.",
	"- Replies matter most when they are specific, fast, and likely to create useful downstream conversation. Low-effort replies create negative feedback risk.",
	"- Search should cover both in-orbit keywords and adjacent out-of-network audiences: elizaOS, AI agents, agent frameworks, personal AI, developer tools, autonomous workflows, and the user's active product terms.",
	"- Prefer recent posts with real conversation potential over huge stale posts. Avoid bait, giveaways, outrage loops, politics traps, spam, and generic viral slop.",
	"- Follow only authors with durable fit, not one-off viral posts. Author diversity matters; do not hammer one account or one thread.",
	"- Status posts should be original, concrete, concise, and public-safe. Do not leak private context or promise product state the app cannot prove.",
	"- Public writes are gated: notification replies use X_AUTONOMY_WRITE; proactive discovery replies/likes/follows require X_AUTONOMY_PROACTIVE_ENGAGEMENT_ENABLED; status posts require X_AUTONOMY_POST_STATUS_ENABLED.",
	"",
	"Primary sources:",
	"https://github.com/xai-org/x-algorithm",
	"https://github.com/xai-org/x-algorithm/blob/main/home-mixer/scorers/weighted_scorer.rs",
	"https://github.com/xai-org/x-algorithm/blob/main/home-mixer/candidate_pipeline/phoenix_candidate_pipeline.rs",
	"https://github.com/twitter/the-algorithm",
	"https://github.com/twitter/the-algorithm/blob/main/RETREIVAL_SIGNALS.md",
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

function readListSetting(runtime: IAgentRuntime, key: string, defaultValue: string[]): string[] {
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

function buildXAutonomyMetadata(current: unknown, runtime: IAgentRuntime): TaskMetadata {
	const intervalMs = Math.max(
		30_000,
		Math.min(30 * 60_000, readNumberSetting(runtime, "X_AUTONOMY_INTERVAL_MS", X_AUTONOMY_DEFAULT_INTERVAL_MS)),
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

async function decideXAutonomyAction(
	runtime: IAgentRuntime,
	params: {
		viewerScreenName: string;
		fromUserScreenName?: string;
		kind: string;
		notificationMessage?: string;
		tweetText: string;
	},
): Promise<XAutonomyDecision> {
	const prompt = [
		`You are autonomously managing the X account @${params.viewerScreenName}.`,
		"Decide whether to reply, like, or ignore this notification.",
		"Rules:",
		"- Reply only when the tweet is directly addressed to the account or clearly invites a response.",
		"- Ignore likes, follows, generic boosts, bait, spam, arguments, and anything unsafe.",
		"- Keep replies warm, concise, specific, and under 240 characters.",
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
	const raw = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
	return parseToonKeyValue<XAutonomyDecision>(String(raw)) ?? { action: "ignore", reason: "unparseable model output" };
}

async function buildRecentAutonomyContext(runtime: IAgentRuntime, task: Task): Promise<string> {
	const roomId = task.roomId ?? runtime.agentId;
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

async function decideXStatusPost(
	runtime: IAgentRuntime,
	params: {
		viewerScreenName: string;
		context: string;
	},
): Promise<XStatusDecision> {
	const prompt = [
		`You are composing one autonomous X status for @${params.viewerScreenName}.`,
		"Write only if there is a useful, public-safe status update to share.",
		"Rules:",
		"- The status must be under 240 characters.",
		"- Be concrete, warm, and agent-native.",
		"- Do not include private names, message contents, secrets, tokens, file paths, screenshots, or internal logs.",
		"- Do not claim launches, production readiness, financial results, or guarantees.",
		"- No hashtags unless truly useful. No engagement bait.",
		"",
		params.context ? `Recent internal context:\n${params.context}` : "Recent internal context: (none)",
		"",
		"Output TOON only:",
		"should_post: true | false",
		"text: <status text, required when should_post is true>",
		"reason: <brief>",
	].join("\n");
	const raw = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
	return parseToonKeyValue<XStatusDecision>(String(raw)) ?? { should_post: false, reason: "unparseable model output" };
}

function modelErrorReason(err: unknown): string {
	return `model unavailable: ${err instanceof Error ? err.message : String(err)}`;
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

function scoreDiscoveryTweet(tweet: XTweetSummary, query: string, now: number): XDiscoveryCandidate {
	const createdAt = tweetCreatedAtMs(tweet);
	const ageHours = createdAt > 0 ? Math.max(0, (now - createdAt) / 3_600_000) : 72;
	const queryTerms = tokenize(query);
	const tweetTerms = new Set(tokenize(tweet.text));
	const overlap = queryTerms.filter((term) => tweetTerms.has(term)).length;
	const favoriteCount = tweet.favoriteCount ?? 0;
	const retweetCount = tweet.retweetCount ?? 0;
	const replyCount = tweet.replyCount ?? 0;
	const engagement = Math.log1p(replyCount * 4 + retweetCount * 2 + favoriteCount);
	const recency = ageHours <= 3 ? 4 : ageHours <= 12 ? 2.5 : ageHours <= 24 ? 1 : ageHours <= 72 ? 0 : -3;
	const relevance = queryTerms.length > 0 ? (overlap / queryTerms.length) * 5 : 1;
	const lengthScore = tweet.text.length >= 45 && tweet.text.length <= 240 ? 1.5 : 0;
	const baitPenalty = textContainsBait(tweet.text) ? 6 : 0;
	const score = Math.max(0, engagement + recency + relevance + lengthScore - baitPenalty);
	const reasonParts = [
		`query "${query}"`,
		ageHours <= 24 ? "recent" : "older",
		replyCount > 0 ? `${replyCount} replies` : "low replies",
		overlap > 0 ? `${overlap} keyword hits` : "semantic fit only",
	];
	if (baitPenalty > 0) reasonParts.push("bait penalty");
	return { tweet, query, score: Number(score.toFixed(2)), reason: reasonParts.join(", ") };
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
	for (const query of params.queries.slice(0, 8)) {
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

async function decideXDiscoveryAction(
	runtime: IAgentRuntime,
	params: {
		viewerScreenName: string;
		candidate: XDiscoveryCandidate;
	},
): Promise<XDiscoveryDecision> {
	const tweet = params.candidate.tweet;
	const prompt = [
		`You are autonomously growing the X account @${params.viewerScreenName}.`,
		"Use this algorithm-aware strategy:",
		X_ALGORITHM_PLAYBOOK,
		"",
		"Decide whether this discovered post deserves a reply, like, follow, or ignore.",
		"Rules:",
		"- Reply only if you can add specific, useful context in the account's voice.",
		"- Like when the post is relevant but does not need a reply.",
		"- Follow only if the author is clearly relevant to the account's long-term graph.",
		"- Ignore bait, spam, culture-war traps, outrage, scams, and vague hype.",
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
		"",
		"Output TOON only:",
		"action: reply | like | follow | ignore",
		"reply_text: <required only when action is reply>",
		"reason: <brief>",
	].join("\n");
	const raw = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
	return parseToonKeyValue<XDiscoveryDecision>(String(raw)) ?? { action: "ignore", reason: "unparseable model output" };
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

async function executeXAutonomyTask(runtime: IAgentRuntime, task: Task): Promise<void> {
	if (!readBooleanSetting(runtime, "X_AUTONOMY_ENABLED", true)) return;
	const { client, error } = buildClient(runtime);
	if (!client) {
		logger.warn({ src: "x-autonomy", error }, "X autonomy skipped; auth unavailable");
		return;
	}

	const writeEnabled = readBooleanSetting(runtime, "X_AUTONOMY_WRITE", true);
	const statusPostingEnabled = readBooleanSetting(runtime, "X_AUTONOMY_POST_STATUS_ENABLED", false);
	const discoveryEnabled = readBooleanSetting(runtime, "X_AUTONOMY_DISCOVERY_ENABLED", true);
	const proactiveEngagementEnabled = readBooleanSetting(runtime, "X_AUTONOMY_PROACTIVE_ENGAGEMENT_ENABLED", false);
	const followEnabled = readBooleanSetting(runtime, "X_AUTONOMY_FOLLOW_ENABLED", false);
	const discoveryQueries = readListSetting(runtime, "X_AUTONOMY_DISCOVERY_QUERIES", X_AUTONOMY_DEFAULT_DISCOVERY_QUERIES);
	const statusIntervalMs = Math.max(
		15 * 60_000,
		Math.min(24 * 60 * 60_000, readNumberSetting(runtime, "X_AUTONOMY_STATUS_INTERVAL_MS", X_AUTONOMY_DEFAULT_STATUS_INTERVAL_MS)),
	);
	const discoveryIntervalMs = Math.max(
		5 * 60_000,
		Math.min(24 * 60 * 60_000, readNumberSetting(runtime, "X_AUTONOMY_DISCOVERY_INTERVAL_MS", X_AUTONOMY_DEFAULT_DISCOVERY_INTERVAL_MS)),
	);
	const maxReplies = Math.max(1, Math.min(5, readNumberSetting(runtime, "X_AUTONOMY_MAX_REPLIES_PER_TICK", 2)));
	const maxDiscovery = Math.max(0, Math.min(8, readNumberSetting(runtime, "X_AUTONOMY_MAX_DISCOVERY_PER_TICK", 2)));
	const metadata = isRecord(task.metadata) ? task.metadata : {};
	const seen = new Set(readSeenIds(metadata));
	const nextSeen = new Set(seen);
	const handled: Array<Record<string, unknown>> = [];
	let lastStatusAt = readTimestamp(metadata.xAutonomyLastStatusAt);
	let lastDiscoveryAt = readTimestamp(metadata.xAutonomyLastDiscoveryAt);
	let lastStatusTweetId = typeof metadata.xAutonomyLastStatusTweetId === "string" ? metadata.xAutonomyLastStatusTweetId : undefined;

	let viewerScreenName = "unknown";
	try {
		const viewer = await client.viewer();
		viewerScreenName = viewer.screenName;
		const notifications = await client.getNotifications();
		const candidates = notifications
			.filter((n) => (n.kind === "mention" || n.kind === "reply") && n.tweetId && !seen.has(n.id))
			.slice(0, maxReplies);

		for (const notification of candidates) {
			nextSeen.add(notification.id);
			const tweet = notification.tweetId ? await client.getTweet(notification.tweetId) : null;
			if (!tweet) {
				handled.push({ id: notification.id, action: "ignore", reason: "tweet not found" });
				continue;
			}
			if (tweet.authorScreenName?.toLowerCase() === viewer.screenName.toLowerCase()) {
				handled.push({ id: notification.id, tweetId: tweet.tweetId, action: "ignore", reason: "self-authored tweet" });
				continue;
			}
			const decision = await safeXAutonomyDecision(runtime, {
				viewerScreenName: viewer.screenName,
				fromUserScreenName: notification.fromUserScreenName ?? tweet.authorScreenName,
				kind: notification.kind,
				notificationMessage: notification.message,
				tweetText: tweet.text,
			});
			const action = String(decision.action ?? "ignore").trim().toLowerCase();
			const replyText = compactText(decision.reply_text, 260);
			if (action === "reply" && replyText.length > 0) {
				if (writeEnabled) {
					const result = await client.reply(replyText, tweet.tweetId);
					handled.push({
						id: notification.id,
						tweetId: tweet.tweetId,
						action,
						success: result.success,
						resultTweetId: result.tweetId,
						error: result.error,
					});
				} else {
					handled.push({ id: notification.id, tweetId: tweet.tweetId, action: "reply_dry_run", text: replyText });
				}
				continue;
			}
			if (action === "like") {
				if (writeEnabled) {
					const result = await client.like(tweet.tweetId);
					handled.push({ id: notification.id, tweetId: tweet.tweetId, action, success: result.success, error: result.error });
				} else {
					handled.push({ id: notification.id, tweetId: tweet.tweetId, action: "like_dry_run" });
				}
				continue;
			}
			handled.push({ id: notification.id, tweetId: tweet.tweetId, action: "ignore", reason: decision.reason });
		}

		for (const notification of notifications.slice(0, 100)) {
			if (notification.kind !== "mention" && notification.kind !== "reply") {
				nextSeen.add(notification.id);
			}
		}

		if (discoveryEnabled && maxDiscovery > 0 && Date.now() - lastDiscoveryAt >= discoveryIntervalMs) {
			const candidates = await discoverXCandidates(client, {
				viewerScreenName: viewer.screenName,
				queries: discoveryQueries,
				seen: nextSeen,
				limit: maxDiscovery,
			});
			for (const candidate of candidates) {
				const tweet = candidate.tweet;
				nextSeen.add(`discover:${tweet.tweetId}`);
				const decision = await safeXDiscoveryDecision(
					runtime,
					{
						viewerScreenName: viewer.screenName,
						candidate,
					},
					proactiveEngagementEnabled,
				);
				const action = String(decision.action ?? "ignore").trim().toLowerCase();
				const replyText = compactText(decision.reply_text, 260);
				const base = {
					tweetId: tweet.tweetId,
					authorScreenName: tweet.authorScreenName,
					query: candidate.query,
					score: candidate.score,
					reason: decision.reason ?? candidate.reason,
				};
				if (action === "reply" && replyText.length > 0) {
					if (writeEnabled && proactiveEngagementEnabled) {
						const result = await client.reply(replyText, tweet.tweetId);
						handled.push({
							...base,
							action: "discover_reply",
							success: result.success,
							resultTweetId: result.tweetId,
							error: result.error,
						});
					} else {
						handled.push({ ...base, action: "discover_reply_dry_run", text: replyText });
					}
					continue;
				}
				if (action === "like") {
					if (writeEnabled && proactiveEngagementEnabled) {
						const result = await client.like(tweet.tweetId);
						handled.push({ ...base, action: "discover_like", success: result.success, error: result.error });
					} else {
						handled.push({ ...base, action: "discover_like_dry_run" });
					}
					continue;
				}
				if (action === "follow" && tweet.authorId) {
					if (writeEnabled && proactiveEngagementEnabled && followEnabled) {
						const result = await client.follow(tweet.authorId);
						handled.push({ ...base, action: "discover_follow", success: result.success, error: result.error });
					} else {
						handled.push({ ...base, action: "discover_follow_dry_run" });
					}
					continue;
				}
				handled.push({ ...base, action: "discover_ignore" });
			}
			lastDiscoveryAt = Date.now();
		}

		if (statusPostingEnabled && Date.now() - lastStatusAt >= statusIntervalMs) {
			const context = await buildRecentAutonomyContext(runtime, task);
			const decision = await safeXStatusDecision(runtime, {
				viewerScreenName: viewer.screenName,
				context,
			});
			const text = compactText(decision.text, 260);
			if (readModelBoolean(decision.should_post) && text.length > 0) {
				if (writeEnabled) {
					const result = await client.tweet(text);
					handled.push({
						action: "post_status",
						success: result.success,
						tweetId: result.tweetId,
						error: result.error,
					});
					if (result.success) {
						lastStatusAt = Date.now();
						lastStatusTweetId = result.tweetId;
					}
				} else {
					handled.push({ action: "post_status_dry_run", text });
					lastStatusAt = Date.now();
				}
			} else {
				handled.push({ action: "post_status_skip", reason: decision.reason ?? "model declined" });
				lastStatusAt = Date.now();
			}
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.warn({ src: "x-autonomy", error: message }, "X autonomy tick failed");
		await logXAutonomy(runtime, task, { ok: false, error: message, viewerScreenName });
		throw err;
	} finally {
		if (task.id) {
			const recentSeen = Array.from(nextSeen).slice(-X_AUTONOMY_SEEN_LIMIT);
			await runtime.updateTask(task.id, {
				metadata: {
					...metadata,
					xAutonomySeenIds: recentSeen,
					xAutonomyLastRunAt: Date.now(),
					xAutonomyLastStatusAt: lastStatusAt,
					xAutonomyLastDiscoveryAt: lastDiscoveryAt,
					...(lastStatusTweetId ? { xAutonomyLastStatusTweetId: lastStatusTweetId } : {}),
					xAutonomyLastHandled: handled,
				},
			}).catch(() => {});
		}
	}

	await logXAutonomy(runtime, task, {
		ok: true,
		viewerScreenName,
		writeEnabled,
		discoveryEnabled,
		proactiveEngagementEnabled,
		handledCount: handled.length,
		handled,
	});
	logger.info(
		{ src: "x-autonomy", handledCount: handled.length, writeEnabled, discoveryEnabled, proactiveEngagementEnabled },
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
		"Reply to a tweet by its numeric ID. Use for specific, useful conversation, especially direct " +
		"mentions and replies to your posts; X's open-source ranking pipeline predicts reply and downstream " +
		"conversation probability as core engagement signals.",
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
			.slice(0, 8)
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
		statusPostingEnabled: readBooleanSetting(runtime, "X_AUTONOMY_POST_STATUS_ENABLED", false),
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

export const xAlgorithmPlaybookAction: Action = {
	name: "X_ALGORITHM_PLAYBOOK",
	similes: ["X_GROWTH_PLAYBOOK", "X_ALGO_PLAYBOOK", "TWITTER_ALGORITHM_PLAYBOOK"],
	description:
		"Return the agent's algorithm-aware X strategy, source links, guardrails, and current autonomy flags.",
	validate: alwaysValid,
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
		"notifications, algorithm playbook, and algorithm-fit discovery. Reads X_AUTH_TOKEN + X_CT0 " +
		"from the vault. Autonomy handles direct notifications by default and performs read-only " +
		"discovery unless proactive public engagement is explicitly enabled.",
	actions: [
		xPostAction,
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
	],
	services: [XAutonomyService],
};

export default xTweetsPlugin;
export { XClient } from "./x-client";
export type { XCookies, XPostResult, XClientOptions, XViewer, XTweetSummary, XUserSummary, XSearchOptions, XNotification } from "./x-client";
