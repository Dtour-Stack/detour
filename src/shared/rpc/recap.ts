/**
 * Recap / open-questions RPC.
 *
 * When the agent can't answer something AND can't look it up, it flags an open
 * question (FLAG_OPEN_QUESTION action → ~/.detour/open-questions.json). A nightly
 * recap surfaces the unanswered ones via email + a UI pop-up on next app open.
 * The user answers inline; answers are ingested as knowledge so the agent learns
 * them.
 *
 * `OpenQuestion` is the single source of truth for the wire shape — the bun-side
 * recap-service and the open-questions plugin both import it from here (shared is
 * a leaf: no fs/bun deps).
 */

export interface OpenQuestion {
	readonly id: string;
	readonly question: string;
	readonly context?: string;
	readonly channel?: string;
	readonly createdAt: number;
	readonly answered: boolean;
	readonly answer?: string;
	readonly answeredAt?: number;
}

export type RecapRequests = {
	getOpenQuestions: {
		params: { includeAnswered?: boolean };
		response: { questions: OpenQuestion[]; pendingRecap: boolean };
	};
	answerOpenQuestion: {
		params: { id: string; answer: string };
		response: { ok: boolean; question?: OpenQuestion };
	};
	dismissOpenQuestion: {
		params: { id: string };
		response: { ok: boolean };
	};
	/** Clears the pending-recap flag once the user has seen the pop-up. */
	acknowledgeRecap: {
		params: Record<never, never>;
		response: { ok: boolean };
	};
};

export type RecapMessages = {
	/** Bun → view: a recap was just generated; show the pop-up. */
	recapPending: { count: number };
};
