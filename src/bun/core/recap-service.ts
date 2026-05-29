/**
 * Recap service — owner of the "open questions" loop.
 *
 * The open-questions store (`~/.detour/open-questions.json`) is appended to by
 * the `open-questions` plugin's FLAG_OPEN_QUESTION action (file-as-contract —
 * the plugin never imports core). This service is the only reader/answerer:
 *  - a daily timer composes a recap of unanswered questions, emails it (best
 *    effort, via the agentmail channel), and raises a "pending recap" flag +
 *    broadcast so the UI pops it up on next open;
 *  - `answer()` records the owner's answer AND ingests it as knowledge, so the
 *    agent knows it thereafter.
 *
 * A private daily timer is used rather than cron-service: cron-service schedules
 * agent PROMPTS, but the recap is deterministic code (compose → email → flag).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "@elizaos/core";
import type { OpenQuestion } from "../../shared/rpc/recap";
import type { PensieveKnowledgeService } from "./pensieve/knowledge-service";

const STORE_DIR = join(homedir(), ".detour");
const STORE_PATH = join(STORE_DIR, "open-questions.json");
const RECAP_HOUR_UTC = 6;
const CHECK_INTERVAL_MS = 30 * 60_000;

interface Store {
	pendingRecap: boolean;
	lastRecapDateUtc: string | null;
	questions: OpenQuestion[];
}

function readStore(): Store {
	try {
		if (!existsSync(STORE_PATH)) return { pendingRecap: false, lastRecapDateUtc: null, questions: [] };
		const raw = JSON.parse(readFileSync(STORE_PATH, "utf8")) as Partial<Store>;
		return {
			pendingRecap: Boolean(raw.pendingRecap),
			lastRecapDateUtc: typeof raw.lastRecapDateUtc === "string" ? raw.lastRecapDateUtc : null,
			questions: Array.isArray(raw.questions) ? (raw.questions as OpenQuestion[]) : [],
		};
	} catch {
		return { pendingRecap: false, lastRecapDateUtc: null, questions: [] };
	}
}

function writeStore(store: Store): void {
	try {
		if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true });
		writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
	} catch (err) {
		logger.warn({ src: "recap", err: err instanceof Error ? err.message : err }, "write open-questions store failed");
	}
}

type RecapDeps = {
	knowledge: Pick<PensieveKnowledgeService, "ingest" | "available">;
	sendEmail?: (to: string, subject: string, body: string) => Promise<unknown>;
	broadcast?: (count: number) => void;
};

export class RecapService {
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(private readonly deps: RecapDeps) {}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.maybeRunDaily().catch((err) => logger.warn({ src: "recap", err: err instanceof Error ? err.message : err }, "recap tick failed"));
		}, CHECK_INTERVAL_MS);
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	listOpen(includeAnswered = false): OpenQuestion[] {
		const questions = readStore().questions;
		return includeAnswered ? questions : questions.filter((q) => !q.answered);
	}

	isPending(): boolean {
		return readStore().pendingRecap;
	}

	acknowledge(): void {
		const store = readStore();
		if (store.pendingRecap) {
			store.pendingRecap = false;
			writeStore(store);
		}
	}

	dismiss(id: string): boolean {
		const store = readStore();
		const next = store.questions.filter((q) => q.id !== id);
		if (next.length === store.questions.length) return false;
		store.questions = next;
		writeStore(store);
		return true;
	}

	async answer(id: string, answer: string): Promise<OpenQuestion | null> {
		const trimmed = answer.trim();
		if (!trimmed) return null;
		const store = readStore();
		const existing = store.questions.find((q) => q.id === id);
		if (!existing) return null;
		const updated: OpenQuestion = { ...existing, answered: true, answer: trimmed, answeredAt: Date.now() };
		store.questions = store.questions.map((q) => (q.id === id ? updated : q));
		writeStore(store);
		// Ingest Q→A as knowledge so the agent recalls it from then on.
		if (this.deps.knowledge.available()) {
			await this.deps.knowledge
				.ingest({
					content: `Q: ${existing.question}\nA: ${trimmed}`,
					contentType: "text/plain",
					filename: `open-question-${id}.txt`,
					metadata: { source: "owner-recap-answer", openQuestionId: id },
				})
				.catch((err) => logger.warn({ src: "recap", err: err instanceof Error ? err.message : err }, "knowledge ingest of answer failed"));
		}
		return updated;
	}

	private async maybeRunDaily(now = new Date()): Promise<void> {
		if (now.getUTCHours() < RECAP_HOUR_UTC) return;
		const dateUtc = now.toISOString().slice(0, 10);
		const store = readStore();
		if (store.lastRecapDateUtc === dateUtc) return; // already ran today
		store.lastRecapDateUtc = dateUtc;
		const open = store.questions.filter((q) => !q.answered);
		if (open.length === 0) {
			writeStore(store);
			return;
		}
		store.pendingRecap = true;
		writeStore(store);

		const to = process.env.RECAP_EMAIL?.trim();
		if (to && this.deps.sendEmail) {
			const body = [
				"Detour Squirrel nightly recap — open questions he couldn't answer or look up:",
				"",
				...open.map((q, i) => `${i + 1}. ${q.question}${q.context ? `\n   (context: ${q.context})` : ""}`),
				"",
				"Answer these in the app pop-up and he'll learn them for next time.",
			].join("\n");
			await this.deps
				.sendEmail(to, `Detour recap: ${open.length} open question${open.length === 1 ? "" : "s"}`, body)
				.catch((err) => logger.warn({ src: "recap", err: err instanceof Error ? err.message : err }, "recap email failed"));
		}
		this.deps.broadcast?.(open.length);
		logger.info({ src: "recap", open: open.length, emailed: Boolean(to && this.deps.sendEmail) }, "nightly recap generated");
	}
}
