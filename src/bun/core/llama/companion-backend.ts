/**
 * CompanionBackend — the shape that every job dispatcher implements.
 *
 * Two implementations live alongside this file:
 *
 *  - CompanionLlmBackend (in companion-service.ts) — the existing
 *    /v1/completions sidecar. Generative, ~3 GB live RAM, ~80-250ms
 *    per call.
 *
 *  - CompanionClassicalBackend (in companion-classical-backend.ts)
 *    — cosine-to-centroid classification + regex shortlists + extractive
 *    summarization. ~0 GB extra RAM (rides the existing bge embedding
 *    server), ~5-30ms per call. Personality-blind by design — every
 *    answer is deterministic for a given input.
 *
 * CompanionService composes both: each of the five jobs has a
 * per-job assignment that decides which backend handles it. Defaults
 * favor classical for the 4 classifier/extraction jobs and the LLM
 * for personaPrePass (the only truly generative one).
 *
 * Each backend exposes a `kind` so the recentJobs log can show which
 * path served each call ("classical" / "llm"), and an `availability`
 * accessor so the UI can warn when a job is routed to a backend that
 * isn't healthy.
 */

import type { TriageLabel } from "./companion-jobs";

export type CompanionBackendKind = "classical" | "llm";

export type CompanionBackendAvailability = {
	available: boolean;
	/** Human-readable reason when unavailable. Null when available. */
	reason: string | null;
};

export interface CompanionBackend {
	readonly kind: CompanionBackendKind;
	availability(): CompanionBackendAvailability;

	/** Returns null when the backend can't decide; caller falls back to default route. */
	triage(userText: string): Promise<TriageLabel | null>;
	shouldRespond(
		agentName: string,
		channel: string,
		recentMessages: { author: string; text: string }[],
	): Promise<boolean | null>;
	memoryQuery(userText: string): Promise<string[] | null>;
	compress(history: string, targetTokens?: number): Promise<string | null>;
	personaPrePass(agentName: string, userText: string): Promise<string | null>;
}
