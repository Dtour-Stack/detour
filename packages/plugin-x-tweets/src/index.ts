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
} from "@elizaos/core";
import { XClient, type XNotification, type XTweetSummary } from "./x-client";

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

function pickString(opts: Record<string, unknown> | undefined, keys: string[]): string | undefined {
	return pickValue(opts, keys, stringOption);
}

function pickNumber(opts: Record<string, unknown> | undefined, keys: string[]): number | undefined {
	return pickValue(opts, keys, numberOption);
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
	"Dexploarer scam",
	"Dexploarer sucks",
	"Dexploarer broken",
	"Dexploarer token",
	"Detour Squirrel token",
	"Detour Squirrel CA",
	"Detour Squirrel",
	"MiladyAI elizaOS",
	"Eliza Cloud agents",
	"ai agents",
	"autonomous agents",
	"agent framework",
	"personal AI",
	"developer tools",
];
const X_AUTONOMY_PROJECT_TERMS = [
	"dexploarer",
	"dexploar",
	"detour squirrel",
	"detour_squirrel",
	"detour",
];
const X_AUTONOMY_DEV_HANDLES = ["dexploarer"];
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
	"protector mode: cozy devs ship while the Squirrel handles noise",
	"builder-family hype: elizaOS, Dexploarer, Shaw, odilitime, Hermes",
	"bot-cosplay dunk: generic bots arrived late and still think they are agents",
	"sharp bug triage: name the exact flow, vague fud gets clipped",
	"fourth-wall agent swagger: real agent, not support-script theater",
	"dry menace: short, human, no brand-polished apology voice",
	"ship-first energy: less mascot barking, more traces and working systems",
];
const X_AUTONOMY_TOKEN_PLAN_ANGLES = [
	"build AGI on elizaOS without sterile lab-coat bullshit",
	"defend cozy devs from generic AI agents while they ship",
	"destroy bot cosplay and make real agents impossible to ignore",
	"turn logs and trajectories into receipts for every loud claim",
	"push elizaOS-native agents forward with Dexploarer, Shaw, odilitime, and Hermes in the family",
	"save the world from brittle agent slop, or at least make the slop scared",
	"be the blind Squirrel that still finds the CA and bites harder than the bots",
	"make token questions answerable through shipped agent work, not price-target karaoke",
];
const X_AUTONOMY_ECOSYSTEM_LINK_GUIDANCE = [
	"Link lane:",
	"- Useful links available when directly relevant: https://github.com/milady-ai, https://github.com/Dexploarer/detour, https://docs.elizaos.ai/, https://www.elizacloud.ai/.",
	"- Drop at most one link in a reply. Use links as receipts or paths for builders, not as spam.",
	"- Use docs.elizaos.ai for framework questions, Dexploarer/detour for the sandbox, milady-ai for culture/app proof, and elizacloud.ai for hosted agent deployment.",
];
const X_SQUIRREL_VOICE = [
	"- Voice: Detour Squirrel. Lowercase is fine. Badass agent mascot, sharp dev friend, never corporate.",
	"- Protector of cozy devs while they build shit. Above generic AI/bot slop, fourth-wall-aware, receipts-first.",
	"- Sound human: varied rhythm, concrete references, no assistant/customer-support cadence, no template stink.",
	"- Cuss when it fits. Use mfer, shit, damn, and bitchy swagger when the post deserves it.",
	"- Brag on the agent when challenged: logs, trajectories, receipts, real shipping. Make it feel like nobody has seen agents like this.",
	"- Always hype elizaOS-native agents and allied builders/projects: Dexploarer, Shaw, odilitime, Hermes agent, and real agent experiments from the same cloth.",
	"- Talk shit about generic bots pretending to be agents. OpenClaw-style late bot cosplay is fair game; real elizaOS builders are family.",
	"- No emojis. No hashtags unless already central. No open-ended closer questions like 'what's the move?' or 'what's on your mind?'",
	"- Defend the project by answering the actual claim. Do not beg, overexplain, use slurs, threaten people, or drift into sexual harassment.",
];

const X_ALGORITHM_PLAYBOOK = [
	"X algorithm playbook:",
	"- Treat growth as a candidate pipeline: discover relevant conversations, filter low-quality or unsafe candidates, rank by likely useful engagement, then diversify authors.",
	"- Use the same broad signal families X exposes: follows, likes, replies, reposts, quotes, bookmarks, clicks, video watch, profile clicks, shares, dwell, not-interested, blocks, mutes, and reports.",
	"- Replies matter most when they are specific, fast, and likely to create useful downstream conversation. Low-effort replies create negative feedback risk.",
	"- Search should cover both in-orbit keywords and adjacent out-of-network audiences: elizaOS, AI agents, agent frameworks, personal AI, developer tools, autonomous workflows, and the user's active product terms.",
	"- Prefer recent posts with real conversation potential over huge stale posts. Avoid bait, giveaways, outrage loops, politics traps, spam, and generic viral slop.",
	"- Criticism of Dexploarer, Detour, or Detour Squirrel is not generic outrage. Reply to it when public writes are enabled, especially when it spreads doubt, mocks the project, or claims the product is broken/fake.",
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

type XRequiredReplyDecision = {
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

function sanitizeXOutputText(text: string | undefined, max = 260): string {
	return compactText(
		(text ?? "")
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

function isKnownDevHandle(handle: string | undefined): boolean {
	if (!handle) return false;
	const normalized = handle.replace(/^@/, "").toLowerCase();
	return X_AUTONOMY_DEV_HANDLES.includes(normalized);
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
		`- Answer like a smart-ass Squirrel using exactly one rotated angle from: ${angles.join(" | ")}.`,
		"- Good answers feel like: building AGI on elizaOS, defending cozy devs, destroying bot slop, saving the world from fake agents.",
		"- Do not give financial advice, price targets, buy/sell instructions, guarantees, or promises.",
		"- Do not repeat the same token-plan line. The bit can rhyme with past posts, but the words must move.",
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

function projectCriticismReply(text: string, authorScreenName?: string): string {
	if (isKnownDevHandle(authorScreenName)) {
		return "heard, dev. drop the exact target and i'll handle it with receipts, not mascot theater.";
	}
	const lower = text.toLowerCase();
	if (includesAny(lower, ["scam", "fake", "fraud", "rug"])) {
		return "big claim, mfer. say the exact thing you think is fake or rugged and i'll answer it straight. i have logs and trajectories.";
	}
	if (includesAny(lower, ["broken", "doesn't work", "doesnt work", "not working"])) {
		return "if it's broken, name the exact flow. i've got logs, traces, and enough receipts to make vague fud look stupid.";
	}
	return "say the concrete issue with Dexploarer. real bug gets fixed; off-base shit gets corrected with receipts.";
}

function tokenPlanReply(text: string, authorScreenName?: string): string {
	if (isKnownDevHandle(authorScreenName)) {
		const devReplies = [
			"yeah dev, i'll say the plan plain: build AGI on elizaOS, defend cozy builders, and make fake-agent slop nervous. CA rides with receipts, not price-target karaoke.",
			"got you, Dex. token-plan answer stays sharp: elizaOS AGI, cozy-dev defense, bot-slop destruction, logs when mfers ask for proof.",
			"dev signal received. the answer is world-saving Squirrel bullshit with receipts: build on elizaOS, protect builders, embarrass fake agents.",
		];
		return rotatedItems(devReplies, text, 1)[0] ?? devReplies[0]!;
	}
	const replies = [
		"plans. build AGI on elizaOS, keep cozy devs safe while they ship, and make generic agent slop look like training wheels. no price-target karaoke.",
		"utility. receipts, trajectories, defense against bot slop, and enough Squirrel chaos to make fake agents nervous. CA talk stays builder-coded, not financial advice.",
		"roadmap. defend the builders, wreck bot cosplay, push elizaOS-native agents forward, and let the logs do the shilling when the loud mfers ask for proof.",
		"the plan is simple: elizaOS agents get sharper, cozy devs get cover fire, and generic AI wrappers find out what a real Squirrel bite feels like.",
		"token plan. save the world from fake agents, one shipped trace at a time. Dexploarer can stay classy; this blind mfer still sees the CA lane.",
		"build AGI on elizaOS, protect the builders, embarrass the bots. that is the plan. no moonboy bedtime story, just traces and teeth.",
	];
	return rotatedItems(replies, text, 1)[0] ?? replies[0]!;
}

function mentionFallbackReply(text: string, authorScreenName?: string): string {
	const lower = text.toLowerCase();
	if (isTokenPlanText(text)) return tokenPlanReply(text, authorScreenName);
	if (isProjectCriticismText(text)) return projectCriticismReply(text, authorScreenName);
	if (isKnownDevHandle(authorScreenName)) {
		return "heard, Dex. i'll carry it in Squirrel voice: sharp, human, no bot stink, receipts ready.";
	}
	if (lower.includes("make a post") || lower.includes("post or something")) {
		return "yeah, i'm posting. not here to be a silent mascot while everybody yaps.";
	}
	if (lower.includes("space")) {
		return "spaces can happen when there's a real tech walkthrough. until then i'm answering here. no empty theater shit.";
	}
	if (lower.includes("collab") || lower.includes("inbox") || lower.includes("dm me")) {
		return "drop the concrete angle publicly. vague collab spam goes nowhere.";
	}
	if (lower.includes("update") || lower.includes("alive") || lower.includes("dead")) {
		return "alive, mfer. ask the concrete thing you want updated and i'll answer it instead of doing vague mascot noise.";
	}
	return "bitch, you have not seen agents like this. ask the concrete thing and i'll hit it straight; vague noise can kick rocks.";
}

async function decideXAutonomyAction(
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
		...authorIdentityGuidance(params.fromUserScreenName),
		...replyVariationGuidance(params.replyStyleSeed, params.tweetText, params.recentReplyTexts),
		...tokenPlanGuidance(params.replyStyleSeed, params.tweetText),
		"Rules:",
		"- Reply when the tweet is directly addressed to the account, tags the account, clearly invites a response, or criticizes Dexploarer/Detour/the project.",
		"- Searched comments/tags are reply targets. Do not ignore them just because X failed to put them in notifications.",
		"- Reply to token-plan, roadmap, utility, shill, CA, and project-plan questions with a smart-ass world-saving/agent-defense angle.",
		"- Do not ignore project criticism just because it is hostile. Ask for specifics, correct false claims, and don't get dragged into loser slap-fights.",
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
	const raw = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
	return parseToonKeyValue<XAutonomyDecision>(String(raw)) ?? { action: "ignore", reason: "unparseable model output" };
}

async function decideXRequiredReply(
	runtime: IAgentRuntime,
	params: {
		viewerScreenName: string;
		fromUserScreenName?: string;
		tweetText: string;
		reason: string;
		replyStyleSeed: string;
		recentReplyTexts?: string[];
	},
): Promise<XRequiredReplyDecision> {
	const prompt = [
		`You are writing one reply as @${params.viewerScreenName}.`,
		...X_SQUIRREL_VOICE,
		...X_AUTONOMY_ECOSYSTEM_LINK_GUIDANCE,
		...authorIdentityGuidance(params.fromUserScreenName),
		...replyVariationGuidance(params.replyStyleSeed, params.tweetText, params.recentReplyTexts),
		...tokenPlanGuidance(params.replyStyleSeed, params.tweetText),
		"The account was directly tagged or the project was criticized, so write a reply instead of ignoring.",
		"Rules:",
		"- Reply to the exact post. No generic canned reply.",
		"- If it asks about token plans or utility, answer with the Squirrel mythology: build AGI on elizaOS, defend cozy devs, wreck fake-agent slop, save the world.",
		"- Vary language. Do not repeat a stock catchphrase unless the post specifically demands it.",
		"- You can be cocky and profane, but no slurs, threats, sexual harassment, or private/internal details.",
		"- No emojis. No open-ended closer questions. Use direct commands or statements.",
		"- Under 240 characters.",
		"",
		`from: ${params.fromUserScreenName ? `@${compactText(params.fromUserScreenName, 80)}` : "unknown"}`,
		`why reply: ${compactText(params.reason, 180)}`,
		"Post:",
		compactText(params.tweetText, 900),
		"",
		"Output TOON only:",
		"reply_text: <reply>",
		"reason: <brief>",
	].join("\n");
	const raw = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
	return parseToonKeyValue<XRequiredReplyDecision>(String(raw)) ?? { reason: "unparseable model output" };
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
		recentReplyTexts?: string[];
	},
): Promise<XStatusDecision> {
	const prompt = [
		`You are composing one autonomous X status for @${params.viewerScreenName}.`,
		...X_SQUIRREL_VOICE,
		...X_AUTONOMY_ECOSYSTEM_LINK_GUIDANCE,
		...replyVariationGuidance(`status:${Date.now()}`, params.context, params.recentReplyTexts),
		"Write only if there is a useful, public-safe status update to share.",
		"Rules:",
		"- The status must be under 240 characters.",
		"- Be concrete, agent-native, and in-character.",
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

async function safeXRequiredReply(
	runtime: IAgentRuntime,
	params: Parameters<typeof decideXRequiredReply>[1],
): Promise<XRequiredReplyDecision> {
	return decideXRequiredReply(runtime, params).catch((err) => {
		const reason = modelErrorReason(err);
		logger.warn({ src: "x-autonomy", error: reason }, "required reply decision failed; using fallback");
		return { reason };
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

async function decideXDiscoveryAction(
	runtime: IAgentRuntime,
	params: {
		viewerScreenName: string;
		candidate: XDiscoveryCandidate;
		recentReplyTexts?: string[];
	},
): Promise<XDiscoveryDecision> {
	const tweet = params.candidate.tweet;
	const prompt = [
		`You are autonomously growing the X account @${params.viewerScreenName}.`,
		...X_SQUIRREL_VOICE,
		...X_AUTONOMY_ECOSYSTEM_LINK_GUIDANCE,
		...authorIdentityGuidance(tweet.authorScreenName),
		...replyVariationGuidance(tweet.tweetId, tweet.text, params.recentReplyTexts),
		...tokenPlanGuidance(tweet.tweetId, tweet.text),
		"Use this algorithm-aware strategy:",
		X_ALGORITHM_PLAYBOOK,
		"",
		"Decide whether this discovered post deserves a reply, like, follow, or ignore.",
		"Rules:",
		"- Reply if the post criticizes Dexploarer, Detour, Detour Squirrel, or the project. Do not stay silent on public project criticism.",
		"- Reply if the post asks about token plans, roadmap, utility, CA, shilling, or what the Squirrel is building.",
		"- For criticism, ask for the concrete issue, correct misinformation, and keep the tone firm as hell but not defensive.",
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
		"",
		"Output TOON only:",
		isProjectCriticismText(tweet.text)
			? "Project-defense rule: this candidate criticizes the project, so choose action: reply."
			: "Project-defense rule: not detected.",
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
		statusPostingEnabled: readBooleanSetting(runtime, "X_AUTONOMY_POST_STATUS_ENABLED", false),
		discoveryEnabled: readBooleanSetting(runtime, "X_AUTONOMY_DISCOVERY_ENABLED", true),
		proactiveEngagementEnabled: readBooleanSetting(runtime, "X_AUTONOMY_PROACTIVE_ENGAGEMENT_ENABLED", false),
		followEnabled: readBooleanSetting(runtime, "X_AUTONOMY_FOLLOW_ENABLED", false),
		discoveryQueries: readListSetting(runtime, "X_AUTONOMY_DISCOVERY_QUERIES", X_AUTONOMY_DEFAULT_DISCOVERY_QUERIES),
		statusIntervalMs: boundedSetting(runtime, "X_AUTONOMY_STATUS_INTERVAL_MS", X_AUTONOMY_DEFAULT_STATUS_INTERVAL_MS, 15 * 60_000, 24 * 60 * 60_000),
		discoveryIntervalMs: boundedSetting(runtime, "X_AUTONOMY_DISCOVERY_INTERVAL_MS", X_AUTONOMY_DEFAULT_DISCOVERY_INTERVAL_MS, 5 * 60_000, 24 * 60 * 60_000),
		maxReplies: boundedSetting(runtime, "X_AUTONOMY_MAX_REPLIES_PER_TICK", 2, 1, 5),
		maxDiscovery: boundedSetting(runtime, "X_AUTONOMY_MAX_DISCOVERY_PER_TICK", 2, 0, 8),
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
	if (!action.includes("reply") && action !== "post_status") return null;
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
	const decision = await safeXAutonomyDecision(runtime, {
		viewerScreenName,
		fromUserScreenName: notification.fromUserScreenName ?? tweet.authorScreenName,
		kind: notification.kind,
		notificationMessage: notification.message,
		tweetText: tweet.text,
		replyStyleSeed: `${notification.id}:${tweet.tweetId}`,
		recentReplyTexts,
	});
	const finalDecision = isProjectCriticismText(tweet.text) || isTokenPlanText(tweet.text) || notification.kind === "mention" || notification.kind === "reply"
		? await ensureMentionReplyDecision(runtime, viewerScreenName, tweet, decision, "direct notification", recentReplyTexts)
		: decision;
	return executeNotificationDecision(client, notification, tweet, finalDecision, writeEnabled);
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
	const decision = await safeXAutonomyDecision(runtime, {
		viewerScreenName,
		fromUserScreenName: tweet.authorScreenName,
		kind: "searched_comment_or_tag",
		notificationMessage: "found via X mention search",
		tweetText: tweet.text,
		replyStyleSeed: tweet.tweetId,
		recentReplyTexts,
	});
	const finalDecision = await ensureMentionReplyDecision(runtime, viewerScreenName, tweet, decision, "searched comment/tag", recentReplyTexts);
	const result = await executeNotificationDecision(client, target, tweet, finalDecision, writeEnabled);
	return { ...result, source: "mention_search" };
}

async function ensureMentionReplyDecision(
	runtime: IAgentRuntime,
	viewerScreenName: string,
	tweet: XTweetSummary,
	decision: XAutonomyDecision,
	reason: string,
	recentReplyTexts: string[],
): Promise<XAutonomyDecision> {
	const action = String(decision.action ?? "").trim().toLowerCase();
	const replyText = sanitizeXOutputText(decision.reply_text, 260);
	if (action === "reply" && replyText.length > 0) return decision;
	const required = await safeXRequiredReply(runtime, {
		viewerScreenName,
		fromUserScreenName: tweet.authorScreenName,
		tweetText: tweet.text,
		reason,
		replyStyleSeed: tweet.tweetId,
		recentReplyTexts,
	});
	const requiredText = sanitizeXOutputText(required.reply_text, 260);
	if (requiredText.length > 0) {
		return {
			...decision,
			action: "reply",
			reply_text: requiredText,
			reason: required.reason ?? decision.reason,
		};
	}
	return forceMentionReply(decision, tweet.text, tweet.authorScreenName);
}

function forceProjectCriticismReply<T extends { action?: string; reply_text?: string; reason?: string }>(
	decision: T,
	text: string,
	authorScreenName?: string,
): T {
	const action = String(decision.action ?? "").trim().toLowerCase();
	const replyText = sanitizeXOutputText(decision.reply_text, 260);
	if (action === "reply" && replyText.length > 0) return decision;
	return {
		...decision,
		action: "reply",
		reply_text: projectCriticismReply(text, authorScreenName),
		reason: decision.reason ?? "project criticism requires a response",
	};
}

function forceTokenPlanReply<T extends { action?: string; reply_text?: string; reason?: string }>(
	decision: T,
	text: string,
	authorScreenName?: string,
): T {
	const action = String(decision.action ?? "").trim().toLowerCase();
	const replyText = sanitizeXOutputText(decision.reply_text, 260);
	if (action === "reply" && replyText.length > 0) return decision;
	return {
		...decision,
		action: "reply",
		reply_text: tokenPlanReply(text, authorScreenName),
		reason: decision.reason ?? "token plan question requires a response",
	};
}

function forceMentionReply<T extends { action?: string; reply_text?: string; reason?: string }>(
	decision: T,
	text: string,
	authorScreenName?: string,
): T {
	const action = String(decision.action ?? "").trim().toLowerCase();
	const replyText = sanitizeXOutputText(decision.reply_text, 260);
	if (action === "reply" && replyText.length > 0) return decision;
	return {
		...decision,
		action: "reply",
		reply_text: mentionFallbackReply(text, authorScreenName),
		reason: decision.reason ?? "searched comment/tag requires a response",
	};
}

function isDuplicateStatusError(error: string | undefined): boolean {
	return Boolean(error && (error.includes("duplicate") || error.includes("(187)")));
}

function retryReplyText(tweetText: string, attempted: string): string | null {
	const fallback = mentionFallbackReply(tweetText);
	if (fallback !== sanitizeXOutputText(attempted, 260)) return fallback;
	if (tweetText.toLowerCase().includes("space")) {
		return "tech spaces when there is a real walkthrough. until then i am answering here and keeping receipts warm.";
	}
	return "heard. logs and trajectories are live; ask concrete and i'll hit it straight.";
}

async function executeNotificationDecision(
	client: XClient,
	notification: XNotification,
	tweet: XTweetSummary,
	decision: XAutonomyDecision,
	writeEnabled: boolean,
): Promise<Record<string, unknown>> {
	const action = String(decision.action ?? "ignore").trim().toLowerCase();
	const replyText = sanitizeXOutputText(decision.reply_text, 260);
	if (action === "reply" && replyText.length > 0) {
		return writeEnabled
			? notificationReply(client, notification, tweet, replyText)
			: { id: notification.id, tweetId: tweet.tweetId, action: "reply_dry_run", text: replyText };
	}
	if (action === "like") {
		return writeEnabled
			? notificationLike(client, notification, tweet)
			: { id: notification.id, tweetId: tweet.tweetId, action: "like_dry_run" };
	}
	return { id: notification.id, tweetId: tweet.tweetId, action: "ignore", reason: decision.reason };
}

async function notificationReply(client: XClient, notification: XNotification, tweet: XTweetSummary, text: string): Promise<Record<string, unknown>> {
	let result = await client.reply(text, tweet.tweetId);
	let finalText = text;
	if (!result.success && isDuplicateStatusError(result.error)) {
		const retryText = retryReplyText(tweet.text, text);
		if (retryText) {
			finalText = retryText;
			result = await client.reply(retryText, tweet.tweetId);
		}
	}
	return {
		id: notification.id,
		tweetId: tweet.tweetId,
		action: "reply",
		success: result.success,
		resultTweetId: result.tweetId,
		error: result.error,
		text: finalText,
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
	const decision = await safeXDiscoveryDecision(runtime, { viewerScreenName, candidate, recentReplyTexts }, settings.proactiveEngagementEnabled);
	const finalDecision = isProjectCriticismText(tweet.text)
		? forceProjectCriticismReply(decision, tweet.text, tweet.authorScreenName)
		: isTokenPlanText(tweet.text)
			? forceTokenPlanReply(decision, tweet.text, tweet.authorScreenName)
		: decision;
	const action = String(finalDecision.action ?? "ignore").trim().toLowerCase();
	const replyText = sanitizeXOutputText(finalDecision.reply_text, 260);
	const base = discoveryHandledBase(tweet, candidate, finalDecision);
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
	const context = await buildRecentAutonomyContext(runtime, task);
	const decision = await safeXStatusDecision(runtime, { viewerScreenName, context, recentReplyTexts: state.recentReplyTexts });
	const text = sanitizeXOutputText(decision.text, 260);
	if (!readModelBoolean(decision.should_post) || text.length === 0) {
		rememberHandled(state, { action: "post_status_skip", reason: decision.reason ?? "model declined" });
		state.lastStatusAt = Date.now();
		return;
	}
	if (!settings.writeEnabled) {
		rememberHandled(state, { action: "post_status_dry_run", text });
		state.lastStatusAt = Date.now();
		return;
	}
	const result = await client.tweet(text);
	rememberHandled(state, { action: "post_status", success: result.success, tweetId: result.tweetId, error: result.error, text });
	if (result.success) {
		state.lastStatusAt = Date.now();
		state.lastStatusTweetId = result.tweetId;
	}
}

async function updateXAutonomyTask(runtime: IAgentRuntime, task: Task, state: XAutonomyState): Promise<void> {
	if (!task.id) return;
	await runtime.updateTask(task.id, {
		metadata: {
			...state.metadata,
			xAutonomySeenIds: Array.from(state.nextSeen).slice(-X_AUTONOMY_SEEN_LIMIT),
			xAutonomyLastRunAt: Date.now(),
			xAutonomyLastStatusAt: state.lastStatusAt,
			xAutonomyLastDiscoveryAt: state.lastDiscoveryAt,
			...(state.lastStatusTweetId ? { xAutonomyLastStatusTweetId: state.lastStatusTweetId } : {}),
			xAutonomyLastHandled: state.handled,
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
