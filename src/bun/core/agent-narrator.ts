/**
 * Agent narrator — generates real, in-flight one-line descriptions of
 * what the agent is doing right now, by handing the raw event to the
 * local companion model (Qwen3-0.6B running under llama.cpp). The
 * narration is broadcast on `agentNarrate` so the SwiftUI pet's chat
 * bubble can surface it.
 *
 * Why route through the companion: the user wants substantive lines
 * ("planner failed on TEXT_LARGE schema, retrying smaller", not
 * "thinking…"). The companion is a tiny on-device model — every call
 * is ~50-200ms and free. When the companion isn't running, we fall
 * back to the raw `fallback` text so the bubble still says something.
 */

import type { CompanionService } from "./llama/companion-service";
import { broadcaster } from "./rpc/registry";

const NARRATION_MAX_CHARS = 140;

export interface NarrateEvent {
	/// Short tag for telemetry/debugging — "turn-start", "fallback-fired", etc.
	kind: string;
	/// Raw fact the narrator should describe. The companion is told to
	/// rewrite this as a natural-sounding 1-liner.
	fact: string;
	/// Pre-companion fallback text to use if the model isn't available
	/// or returns nothing.
	fallback?: string;
	/// Optional trace id to correlate across events.
	traceId?: string;
}

/// Cheap rate-limit so a chatty event source can't pile up companion
/// calls. Keep the bubble responsive without thrashing the model.
const MIN_INTERVAL_MS = 600;
let lastInvocationAt = 0;

/**
 * Generate + broadcast a one-line narration for an agent event.
 *
 * Fire-and-forget: the caller doesn't wait for the model. If the
 * companion isn't running, broadcasts the fallback text immediately
 * so the bubble still surfaces SOMETHING.
 */
export function narrate(
	companion: CompanionService | undefined,
	event: NarrateEvent,
): void {
	const now = Date.now();
	if (now - lastInvocationAt < MIN_INTERVAL_MS) {
		// Skip the companion call to avoid pile-up; still broadcast the
		// fallback so the bubble doesn't go silent.
		if (event.fallback) {
			broadcaster.broadcast("agentNarrate", {
				text: event.fallback,
				kind: event.kind,
				traceId: event.traceId,
				source: "rate-limited",
			});
		}
		return;
	}
	lastInvocationAt = now;

	// Pre-emptive broadcast with the fallback so the bubble responds
	// instantly. If the companion returns something better, we
	// broadcast again to overwrite.
	if (event.fallback) {
		broadcaster.broadcast("agentNarrate", {
			text: event.fallback,
			kind: event.kind,
			traceId: event.traceId,
			source: "fallback",
		});
	}

	if (!companion) return;
	void (async () => {
		const polished = await runCompanionNarration(companion, event);
		if (polished && polished.length > 0) {
			broadcaster.broadcast("agentNarrate", {
				text: polished,
				kind: event.kind,
				traceId: event.traceId,
				source: "companion",
			});
		}
	})();
}

async function runCompanionNarration(
	companion: CompanionService,
	event: NarrateEvent,
): Promise<string | null> {
	const status = companion.status();
	if (!status.running || !status.url) return null;
	const prompt = buildNarratorPrompt(event);
	try {
		const raw = await companion._callCompletion(status.url, prompt, {
			stop: ["\n\n", "</narration>", "User:"],
			maxTokens: 64,
			temperature: 0.4,
		});
		if (!raw) return null;
		return cleanNarration(raw);
	} catch {
		return null;
	}
}

function buildNarratorPrompt(event: NarrateEvent): string {
	// The active pet bundles a narrator persona + skill focus. Both
	// arrive via runtime env vars set by POST /api/eval/active-pet.
	// Unset = generic Detour squirrel voice.
	const persona = process.env.DETOUR_PET_PERSONA ?? "Pragmatic, witty Detour squirrel — honest about failures, focused on shipping.";
	const skills = process.env.DETOUR_PET_SKILLS ?? "";
	const focusLine = skills.length > 0
		? `Areas you care about: ${skills}.`
		: "";
	return [
		`You are the live narrator inside an autonomous AI agent, telling the user (in plain English) what's happening right now.`,
		`Voice: ${persona}`,
		focusLine,
		`Write ONE short line, max 100 characters. Be specific. If something failed or is sub-optimal, say WHAT failed.`,
		`No "the agent" — describe events directly. No emoji unless directly relevant. No quotes around your answer.`,
		``,
		`Event kind: ${event.kind}`,
		`Raw fact: ${event.fact}`,
		``,
		`Narration:`,
	].filter((l) => l.length > 0).join("\n");
}

function cleanNarration(raw: string): string {
	let s = raw.trim();
	// Strip markdown / quote wrappers the small model sometimes emits.
	s = s.replace(/^["'`]+|["'`]+$/g, "").trim();
	if (s.startsWith("Narration:")) s = s.slice("Narration:".length).trim();
	// Keep just the first non-empty line.
	const firstLine = s.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
	let line = firstLine.trim();
	if (line.length > NARRATION_MAX_CHARS) line = line.slice(0, NARRATION_MAX_CHARS - 1) + "…";
	return line;
}
