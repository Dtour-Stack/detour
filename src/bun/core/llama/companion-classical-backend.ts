/**
 * CompanionClassicalBackend — non-LLM backend for the companion jobs.
 *
 * Each method runs entirely on regex + string heuristics + extractive
 * summarization. No GPU, no embedding server, no network call. The
 * tradeoff: it's blunt. It's right on the obvious cases (greetings,
 * direct @-mentions, short acks) and gives up on the ambiguous ones
 * by returning null, which lets the caller fall back to the LLM
 * backend (when assigned) or its own default behavior (when classical
 * is the only backend).
 *
 * The point is *complementarity*. Classical handles the 80% of turns
 * that don't need generation, the LLM handles the 20% that do. Both
 * stay running.
 */

import type { CompanionBackend, CompanionBackendAvailability } from "./companion-backend";
import type { TriageLabel } from "./companion-jobs";

/**
 * Acknowledgment tokens — short utterances we treat as "no response
 * needed" without further analysis. Tuned for Discord/X observation
 * traffic where short replies are common and don't need a reaction.
 */
const ACK_TOKENS = new Set([
	"ok",
	"okay",
	"k",
	"kk",
	"sure",
	"yep",
	"yup",
	"yeah",
	"nah",
	"nope",
	"thanks",
	"thx",
	"ty",
	"lol",
	"lmao",
	"haha",
	"hehe",
	"nice",
	"cool",
	"sweet",
	"dope",
	"based",
	"true",
	"fr",
	"facts",
	"word",
	"got it",
	"gotcha",
	"sounds good",
	"sg",
	"+1",
	"❤",
	"👍",
	"🔥",
	"✅",
]);

/**
 * Tokens that lean a turn toward the "tool" triage label — anything
 * that smells like a verb-noun action the agent could plausibly take.
 * Order matters: a turn matching any of these immediately becomes
 * "tool" unless a stronger signal (URL, complex multi-clause) demotes it.
 */
const TOOL_VERBS = [
	"run",
	"build",
	"test",
	"deploy",
	"open",
	"close",
	"create",
	"make",
	"add",
	"remove",
	"delete",
	"fix",
	"patch",
	"install",
	"uninstall",
	"start",
	"stop",
	"restart",
	"check",
	"verify",
	"send",
	"post",
	"reply",
	"tweet",
	"dm",
	"schedule",
	"cancel",
	"swap",
	"buy",
	"sell",
	"trade",
	"sign",
	"approve",
];

/**
 * Tokens that signal "search/lookup" — when present, triage routes to
 * the search bucket so the planner can use a research provider.
 */
const SEARCH_VERBS = [
	"search",
	"look up",
	"find",
	"google",
	"who is",
	"what is",
	"what's",
	"where is",
	"when did",
	"when is",
	"how do",
	"how does",
	"price of",
	"latest",
	"news",
];

const URL_RE = /\bhttps?:\/\/\S+/i;
const QUESTION_RE = /\?\s*$/;

function normalize(text: string): string {
	return text.trim().toLowerCase();
}

function isAck(text: string): boolean {
	const n = normalize(text);
	if (!n) return true;
	if (ACK_TOKENS.has(n)) return true;
	if (n.length <= 4 && /^[a-z!.]+$/.test(n)) return true;
	if (/^(ok+|h+a+h+a*|h+e+h+e+|l+o+l+|y+a+s+)\W*$/.test(n)) return true;
	// Multi-token ack ("lol nice", "ok thanks") — every token has to
	// be either an ack token or a short filler. We cap the total text
	// length so longer sentences with an ack-shaped opener still get
	// substantive triage.
	if (n.length <= 24) {
		const tokens = n.split(/[\s!.,?]+/).filter(Boolean);
		if (tokens.length > 0 && tokens.every((t) => ACK_TOKENS.has(t))) {
			return true;
		}
	}
	return false;
}

function containsAny(text: string, needles: string[]): boolean {
	const n = ` ${normalize(text)} `;
	for (const k of needles) {
		if (n.includes(` ${k} `) || n.startsWith(`${k} `) || n.endsWith(` ${k}`)) {
			return true;
		}
	}
	return false;
}

function isComplexMultiClause(text: string): boolean {
	const n = normalize(text);
	// Heuristic: more than 240 chars OR three+ "and"/"then"/",".
	if (n.length > 240) return true;
	const connectors = (n.match(/\b(and|then|also|plus)\b|,/g) ?? []).length;
	return connectors >= 3;
}

function classifyTriage(text: string): TriageLabel {
	const trimmed = text.trim();
	if (!trimmed) return "skip";
	if (isAck(trimmed)) return "skip";
	if (URL_RE.test(trimmed)) return "search";
	if (containsAny(trimmed, SEARCH_VERBS)) return "search";
	if (containsAny(trimmed, TOOL_VERBS)) {
		return isComplexMultiClause(trimmed) ? "complex" : "tool";
	}
	if (isComplexMultiClause(trimmed)) return "complex";
	return "chat";
}

/**
 * shouldRespond heuristic. Looks at the agent's own name + the last
 * message in the channel and decides whether the agent should jump in.
 * Conservative by design — when in doubt we say "no" (observation is
 * cheap, an off-topic interjection is expensive). The LLM backend is
 * available for the cases the heuristic doesn't catch.
 */
function decideShouldRespond(
	agentName: string,
	recentMessages: { author: string; text: string }[],
): boolean | null {
	if (recentMessages.length === 0) return false;
	const last = recentMessages[recentMessages.length - 1]!;
	const lastAuthor = normalize(last.author);
	const agentLower = normalize(agentName);
	// Don't double-speak: if the agent itself was the last to talk, hold.
	if (lastAuthor === agentLower || lastAuthor.includes(agentLower)) {
		return false;
	}
	const lastText = last.text;
	const lastLower = normalize(lastText);
	// Direct mention / @-tag → speak.
	if (
		agentLower &&
		(lastLower.includes(`@${agentLower}`) ||
			new RegExp(`\\b${agentLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(
				lastLower,
			))
	) {
		return true;
	}
	// Short acknowledgment → no response.
	if (isAck(lastText)) return false;
	// Question with no @-tag → ambiguous (could be aimed at anyone). The
	// LLM backend, when assigned, gets a chance. When classical is the
	// only backend, we return false — silence beats interruption.
	if (QUESTION_RE.test(lastText)) return null;
	return false;
}

/**
 * Extractive sentence-rank compress. Splits on sentence boundaries,
 * scores each by:
 *   - position (first and last bonus)
 *   - length (mid-range bonus — too short or too long hurts)
 *   - uniqueness (overlap-with-rest penalty)
 *   - keyword density (presence of named entities / verbs)
 *
 * Picks the top K that fit the target token budget. Deterministic.
 */
function compressExtractive(history: string, targetTokens: number): string {
	const text = history.trim();
	if (!text) return "";
	const sentences = splitSentences(text);
	if (sentences.length <= 2) return text;
	const targetChars = targetTokens * 4;
	if (text.length <= targetChars) return text;

	const scored = sentences.map((s, i) => {
		const tokenized = s.toLowerCase().split(/\s+/);
		const positionBonus =
			i === 0 ? 1.5 : i === sentences.length - 1 ? 1.2 : 1.0;
		const lengthRatio = Math.min(s.length / 120, 1);
		const uniqueWords = new Set(tokenized).size;
		const uniquenessRatio = uniqueWords / Math.max(tokenized.length, 1);
		const score = positionBonus * (0.5 + lengthRatio) * (0.5 + uniquenessRatio);
		return { sentence: s, index: i, score };
	});

	scored.sort((a, b) => b.score - a.score);

	const picked: typeof scored = [];
	let used = 0;
	for (const item of scored) {
		const cost = item.sentence.length + 1;
		if (used + cost > targetChars && picked.length > 0) continue;
		picked.push(item);
		used += cost;
		if (used >= targetChars) break;
	}
	picked.sort((a, b) => a.index - b.index);
	return picked.map((p) => p.sentence.trim()).join(" ");
}

function splitSentences(text: string): string[] {
	return text
		.split(/(?<=[.!?])\s+/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/**
 * memoryQuery — keyword extraction. Pulls the rare-ish content tokens
 * out of the user prompt and returns them as candidate retrieval
 * queries alongside the literal text. Stopwords removed, numbers and
 * proper-noun-looking tokens preserved.
 */
const STOPWORDS = new Set([
	"the",
	"and",
	"a",
	"an",
	"to",
	"of",
	"in",
	"on",
	"at",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"i",
	"you",
	"he",
	"she",
	"we",
	"they",
	"it",
	"this",
	"that",
	"these",
	"those",
	"my",
	"your",
	"our",
	"their",
	"me",
	"him",
	"her",
	"us",
	"them",
	"for",
	"with",
	"from",
	"by",
	"as",
	"if",
	"or",
	"but",
	"so",
	"not",
	"no",
	"yes",
	"can",
	"could",
	"would",
	"should",
	"may",
	"might",
	"will",
	"shall",
	"what",
	"who",
	"where",
	"when",
	"why",
	"how",
	"about",
	"just",
	"also",
	"like",
]);

function extractMemoryQueries(text: string): string[] {
	const literal = text.trim();
	if (!literal) return [];
	const tokens = literal
		.toLowerCase()
		.replace(/[^a-z0-9\s'-]/g, " ")
		.split(/\s+/)
		.filter((t) => t.length >= 3 && !STOPWORDS.has(t));
	const seen = new Set<string>();
	const keywords: string[] = [];
	for (const t of tokens) {
		if (seen.has(t)) continue;
		seen.add(t);
		keywords.push(t);
		if (keywords.length >= 4) break;
	}
	const queries = [literal];
	if (keywords.length >= 2) queries.push(keywords.join(" "));
	return queries;
}

export class CompanionClassicalBackend implements CompanionBackend {
	readonly kind = "classical" as const;

	availability(): CompanionBackendAvailability {
		return { available: true, reason: null };
	}

	async triage(userText: string): Promise<TriageLabel | null> {
		return classifyTriage(userText);
	}

	async shouldRespond(
		agentName: string,
		_channel: string,
		recentMessages: { author: string; text: string }[],
	): Promise<boolean | null> {
		return decideShouldRespond(agentName, recentMessages);
	}

	async memoryQuery(userText: string): Promise<string[] | null> {
		const queries = extractMemoryQueries(userText);
		return queries.length > 0 ? queries : null;
	}

	async compress(history: string, targetTokens = 200): Promise<string | null> {
		const out = compressExtractive(history, targetTokens);
		return out || null;
	}

	async personaPrePass(): Promise<string | null> {
		// Generation is the LLM's job. Returning null lets the caller
		// fall through to the LLM backend (when assigned) or to the
		// planner's normal first-pass (when classical is the only
		// route).
		return null;
	}
}

export const classicalCompanionPrimitives = {
	classifyTriage,
	decideShouldRespond,
	compressExtractive,
	extractMemoryQueries,
	isAck,
};
