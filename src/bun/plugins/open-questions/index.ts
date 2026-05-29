/**
 * Lets the agent flag a question it genuinely can't answer or look up, so it
 * lands in Dexploarer's nightly recap — he answers it, and the answer is ingested
 * as knowledge so the agent knows it thereafter.
 *
 * Decoupled from core: this appends to ~/.detour/open-questions.json (the
 * file-as-contract the core RecapService owns). It imports only the shared
 * OpenQuestion wire type — never src/bun/core.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Action, Handler, Plugin } from "@elizaos/core";
import type { OpenQuestion } from "../../../shared/rpc/recap";

const STORE_DIR = join(homedir(), ".detour");
const STORE_PATH = join(STORE_DIR, "open-questions.json");

function appendOpenQuestion(question: OpenQuestion): void {
	try {
		if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true });
		let store: { pendingRecap?: boolean; lastRecapDateUtc?: string | null; questions?: OpenQuestion[] } = {};
		if (existsSync(STORE_PATH)) {
			try {
				store = JSON.parse(readFileSync(STORE_PATH, "utf8"));
			} catch {
				store = {};
			}
		}
		const questions = Array.isArray(store.questions) ? store.questions : [];
		const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
		// Don't re-flag a still-open near-identical question.
		if (questions.some((q) => !q.answered && norm(q.question) === norm(question.question))) return;
		questions.push(question);
		writeFileSync(
			STORE_PATH,
			JSON.stringify({ pendingRecap: store.pendingRecap ?? false, lastRecapDateUtc: store.lastRecapDateUtc ?? null, questions }, null, 2),
			"utf8",
		);
	} catch {
		/* best-effort */
	}
}

const flagOpenQuestionHandler: Handler = async (_runtime, message, _state, options, callback) => {
	const opts = (options ?? {}) as Record<string, unknown>;
	const question =
		typeof opts.question === "string" ? opts.question.trim() : typeof opts.text === "string" ? opts.text.trim() : "";
	if (!question) {
		await callback?.({ text: "FLAG_OPEN_QUESTION needs a `question`.", action: "FLAG_OPEN_QUESTION" });
		return { success: false, text: "missing question" };
	}
	const context = typeof opts.context === "string" && opts.context.trim() ? opts.context.trim() : undefined;
	const source = (message as { content?: { source?: unknown } } | undefined)?.content?.source;
	const channel = typeof source === "string" ? source : undefined;
	appendOpenQuestion({
		id: randomUUID(),
		question,
		...(context ? { context } : {}),
		...(channel ? { channel } : {}),
		createdAt: Date.now(),
		answered: false,
	});
	await callback?.({ text: `Flagged for Dexploarer's recap: "${question}"`, action: "FLAG_OPEN_QUESTION" });
	return { success: true, text: "flagged open question" };
};

export const flagOpenQuestionAction: Action = {
	name: "FLAG_OPEN_QUESTION",
	similes: ["OPEN_QUESTION", "CANT_ANSWER", "ASK_OWNER", "DONT_KNOW"],
	description:
		"Record a question you genuinely cannot answer or look up, so it goes into Dexploarer's nightly recap — he answers it and you learn it. Use ONLY after you've actually tried to recall/search/browse and still don't know. Not for things you can answer or find yourself.",
	validate: async () => true,
	handler: flagOpenQuestionHandler,
	examples: [],
	parameters: [
		{ name: "question", description: "The question you couldn't answer.", required: true, schema: { type: "string" as const } },
		{ name: "context", description: "Brief context for why it came up.", required: false, schema: { type: "string" as const } },
	],
};

export const openQuestionsPlugin: Plugin = {
	name: "open-questions",
	description: "Lets the agent flag questions it can't answer for the owner's nightly recap, then learn the answers.",
	actions: [flagOpenQuestionAction],
};

export default openQuestionsPlugin;
