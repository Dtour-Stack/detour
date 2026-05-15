/**
 * Shared helpers + types for the Local AI tab and its split cards.
 *
 * The big card components (LocalChatCard, CompanionCard) import from
 * here. Pure functions only; no rendering, no React state.
 */

export type BusyState =
	| ""
	| "save"
	| "test"
	| "clear"
	| "chat-start"
	| "chat-stop"
	| "chat-primary"
	| "companion-start"
	| "companion-stop"
	| "companion-assignments";

export type CompanionJob =
	| "triage"
	| "shouldRespond"
	| "memoryQuery"
	| "compress"
	| "personaPrePass";

export type CompanionBackendChoice = "classical" | "llm" | "off";

export const COMPANION_JOB_DESCRIPTIONS: Record<
	CompanionJob,
	{ label: string; hint: string }
> = {
	triage: {
		label: "Triage",
		hint: "Decide if a turn needs the planner at all (chat / tool / search / complex / skip).",
	},
	shouldRespond: {
		label: "Should-respond",
		hint: "Gate Discord/X observation ticks — skip the silent ones.",
	},
	memoryQuery: {
		label: "Memory query",
		hint: "Rewrite vague prompts into retrieval queries for Pensieve.",
	},
	compress: {
		label: "Compress",
		hint: "Squash long history into a token-budget summary before planning.",
	},
	personaPrePass: {
		label: "Persona pre-pass",
		hint: "Frame the user's intent for the planner in one line — keeps voice consistent across model swaps.",
	},
};

export function fmtBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
	return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function fmtDuration(ms: number): string {
	if (ms < 1000) return `${ms} ms`;
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return `${m}m ${s % 60}s`;
}

/**
 * Rough "does this machine have enough RAM" hint for the per-preset
 * picker. Mirrors the same check the bun-side `LocalChatService` uses,
 * but runs in the view so the dropdown can flag "won't fit" BEFORE
 * the user clicks start. Returns null when navigator.deviceMemory
 * isn't available (Safari).
 */
export function machineFitsLocal(approxLiveRamGB: number): boolean | null {
	const dm = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
	if (typeof dm !== "number" || !Number.isFinite(dm) || dm <= 0) return null;
	const headroom = 4;
	return dm >= approxLiveRamGB + headroom;
}
