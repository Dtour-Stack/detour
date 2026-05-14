/**
 * Dream RPC handlers.
 *
 *   - dreamsList    → DreamService.snapshot
 *   - dreamsRunNow  → DreamService.runNow  (manual trigger; bypasses cron)
 *   - dreamsApply   → DreamService.apply   (commit a staged plan)
 *   - dreamsReject  → DreamService.reject  (discard the staged entries)
 *
 * Apply/reject broadcast `dreamChanged` so the Pensieve "Dreams" pane
 * re-renders without needing a manual refresh.
 */

import type { RpcDeps } from "../types";
import type { DreamApplyResultWire, DreamSummary } from "../../../../shared/rpc/dreams";

function emptyApply(): DreamApplyResultWire {
	return { applied: 0, skipped: 0, failed: 0, errors: [] };
}

export function dreamsRequests(deps: RpcDeps) {
	const broadcast = async (): Promise<void> => {
		const { dreams } = await deps.dream.snapshot();
		deps.broadcaster.broadcast("dreamChanged", { dreams });
	};
	return {
		dreamsList: async (): Promise<{ dreams: DreamSummary[] }> => {
			return deps.dream.snapshot();
		},
		dreamsRunNow: async (
			params: { instructions?: string },
		): Promise<{
			planId: string | null;
			counts: { additions: number; merges: number; replacements: number; deletions: number };
			skipReason?: string;
		}> => {
			const result = await deps.dream.runNow({
				...(typeof params.instructions === "string" ? { instructions: params.instructions } : {}),
			});
			void broadcast();
			return {
				planId: result.planId ?? null,
				counts: {
					additions: result.plan.additions.length,
					merges: result.plan.merges.length,
					replacements: result.plan.replacements.length,
					deletions: result.plan.deletions.length,
				},
				...(result.skipReason ? { skipReason: result.skipReason } : {}),
			};
		},
		dreamsApply: async (
			params: { dreamId: string },
		): Promise<DreamApplyResultWire> => {
			if (!params.dreamId) return emptyApply();
			const result = await deps.dream.apply(params.dreamId);
			void broadcast();
			return result;
		},
		dreamsReject: async (
			params: { dreamId: string },
		): Promise<{ removed: number }> => {
			if (!params.dreamId) return { removed: 0 };
			const result = await deps.dream.reject(params.dreamId);
			void broadcast();
			return result;
		},
	};
}
