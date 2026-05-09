import type { RpcDeps } from "../types";
import { newTraceId, traceScope } from "../../trace";

/**
 * Chat streaming RPC handler. Replaces the WS `chat:send` path.
 *
 * Flow:
 *   1. View calls `rpc.request.chatSend({ convId, text })`.
 *   2. Handler opens a trace scope (so eliza pipeline logs correlate
 *      with the turn) and dispatches via `runtime.sendMessage`.
 *   3. On every delta, broadcasts `chatDelta`. On idle 1.5s after the
 *      last delta, broadcasts `chatComplete`. On error, broadcasts
 *      `chatError`.
 *   4. The request promise resolves `{ ok: true }` once the call
 *      returns from runtime.sendMessage (independent of when the
 *      delta-stream-idle completion fires).
 *
 * Note: matches the legacy WS handler's idle-detection completion
 * pattern (1.5s after last delta, since runtime.sendMessage doesn't
 * itself signal end-of-turn).
 */
export function chatRequests(deps: RpcDeps) {
	return {
		chatSend: async (params: { convId: string; text: string }): Promise<{ ok: true }> => {
			const { convId, text } = params;
			const traceId = newTraceId();
			let completeFired = false;
			let idleTimer: ReturnType<typeof setTimeout> | null = null;
			const fireComplete = () => {
				if (completeFired) return;
				completeFired = true;
				if (idleTimer) clearTimeout(idleTimer);
				deps.broadcaster.broadcast("chatComplete", { convId, traceId });
			};
			const armIdle = () => {
				if (idleTimer) clearTimeout(idleTimer);
				idleTimer = setTimeout(fireComplete, 1500);
			};
			await traceScope(traceId, async () => {
				try {
					await deps.runtime.sendMessage(text, (delta) => {
						deps.broadcaster.broadcast("chatDelta", { convId, delta, traceId });
						armIdle();
					});
					fireComplete();
				} catch (err) {
					if (idleTimer) clearTimeout(idleTimer);
					const message = err instanceof Error ? err.message : String(err);
					deps.broadcaster.broadcast("chatError", { convId, message, traceId });
				}
			});
			return { ok: true };
		},

		/**
		 * Thumbs feedback on an agent reply. Writes a Pensieve memory
		 * tagged `feedback` + `chat-rate` with the trace id, conv id,
		 * rating, and (optionally) the assistant text snippet that was
		 * being rated. The activity tab can later join this against the
		 * trajectory log via traceId for a "human-feedback signal" view.
		 */
		chatRateMessage: async (params: {
			traceId: string;
			convId: string;
			rating: 1 | -1;
			text?: string;
		}): Promise<{ ok: true }> => {
			const { traceId, convId, rating, text } = params;
			try {
				const ratingLabel = rating > 0 ? "thumbs-up" : "thumbs-down";
				await deps.pensieve.memories.create({
					text: text
						? `[${ratingLabel}] ${text.slice(0, 500)}`
						: `[${ratingLabel}] (no snippet)`,
					type: "feedback",
					path: `feedback/chat/${traceId}`,
					tags: ["feedback", "chat-rate", ratingLabel],
					extraMetadata: { traceId, convId, rating },
				});
			} catch (err) {
				console.warn(
					"[chat.rate] failed to record feedback:",
					err instanceof Error ? err.message : err,
				);
			}
			return { ok: true };
		},
	};
}
