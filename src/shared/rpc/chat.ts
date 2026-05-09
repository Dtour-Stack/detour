/**
 * Chat streaming + UI signal RPC. Replaces the legacy `/ws` path:
 *
 *   chat:send    (view→bun) → chatSend (bun.requests; awaitable ack)
 *   chat:delta   (bun→view) → chatDelta (bun.messages)
 *   chat:complete(bun→view) → chatComplete (bun.messages)
 *   chat:error   (bun→view) → chatError (bun.messages)
 *   ui:open-settings (bun→view) → uiOpenSettings (bun.messages)
 *
 * The handler in src/bun/core/rpc/handlers/chat.ts drives a single chat
 * turn; deltas are pushed through `deps.broadcaster.broadcast(...)` while
 * the request promise stays open until the turn completes (or errors).
 */

export type ChatFeedbackRating = 1 | -1;

export type ChatRequests = {
	chatSend: {
		params: { convId: string; text: string };
		response: { ok: true };
	};
	// Thumbs feedback on an agent reply. `traceId` is the assistant
	// turn's trajectory id (same id the chat handler passes through
	// traceScope, surfaced back to the view via chatDelta /
	// chatComplete). Writes a feedback memory tagged with the trace id
	// so the activity tab can render thumbs alongside the existing
	// trajectory entries without changing the upstream eliza schema.
	chatRateMessage: {
		params: {
			traceId: string;
			convId: string;
			rating: ChatFeedbackRating;
			text?: string;
		};
		response: { ok: true };
	};
};

export type ChatMessages = {
	chatDelta: { convId: string; delta: string; traceId?: string };
	chatComplete: { convId: string; traceId?: string };
	chatError: { convId: string; message: string; traceId?: string };
	uiOpenSettings: Record<string, never>;
};
