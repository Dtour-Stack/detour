/**
 * Dream RPC schema — Pensieve memory-consolidation surface.
 *
 * Dreams are batched memory reflections that produce a structured diff
 * (additions / merges / replacements / deletions). The diff is staged for
 * user review by default; `dreamsApply` walks every pending change and
 * commits it. `dreamsReject` drops the staged entries without touching
 * the underlying memories.
 */

export interface DreamSummary {
	id: string;
	createdAt: number;
	summary: string;
	counts: {
		additions?: number;
		merges?: number;
		replacements?: number;
		deletions?: number;
	};
	notes?: string;
	pendingCount: number;
}

export interface DreamApplyResultWire {
	applied: number;
	skipped: number;
	failed: number;
	errors: string[];
}

export type DreamsRequests = {
	dreamsList: {
		params: Record<string, never>;
		response: { dreams: DreamSummary[] };
	};
	dreamsRunNow: {
		params: { instructions?: string };
		response: {
			planId: string | null;
			counts: {
				additions: number;
				merges: number;
				replacements: number;
				deletions: number;
			};
			skipReason?: string;
		};
	};
	dreamsApply: {
		params: { dreamId: string };
		response: DreamApplyResultWire;
	};
	dreamsReject: {
		params: { dreamId: string };
		response: { removed: number };
	};
};

export type DreamsMessages = {
	dreamChanged: { dreams: DreamSummary[] };
};
