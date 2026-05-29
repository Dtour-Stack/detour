/**
 * Recap RPC handlers — open-questions surface for the recap pop-up.
 * All logic lives in RecapService; this only adapts transport → service.
 */
import type { OpenQuestion } from "../../../../shared/rpc/recap";
import type { RpcDeps } from "../types";

export function recapRequests(deps: RpcDeps) {
	return {
		getOpenQuestions: async (
			params: { includeAnswered?: boolean },
		): Promise<{ questions: OpenQuestion[]; pendingRecap: boolean }> => {
			return {
				questions: deps.recap.listOpen(params.includeAnswered),
				pendingRecap: deps.recap.isPending(),
			};
		},
		answerOpenQuestion: async (
			params: { id: string; answer: string },
		): Promise<{ ok: boolean; question?: OpenQuestion }> => {
			const question = await deps.recap.answer(params.id, params.answer);
			return question ? { ok: true, question } : { ok: false };
		},
		dismissOpenQuestion: async (params: { id: string }): Promise<{ ok: boolean }> => {
			return { ok: deps.recap.dismiss(params.id) };
		},
		acknowledgeRecap: async (): Promise<{ ok: boolean }> => {
			deps.recap.acknowledge();
			return { ok: true };
		},
	};
}
