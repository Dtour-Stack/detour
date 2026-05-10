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

import type { ChatCommandInfo } from "../index";

export type ChatFeedbackRating = 1 | -1;

export type ChatRequests = {
	chatSend: {
		params: { convId: string; text: string };
		// Returns immediately after kicking off the agent turn. Actual
		// turn output is streamed via chatDelta/chatComplete/chatError.
		// `traceId` lets the view correlate UI feedback (thumbs) with
		// the trajectory record.
		response: { ok: true; traceId: string };
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
	// Returns the catalog the command palette renders (native chat
	// commands + skill-derived ones once skills are surfaced). Pure
	// read; no side effects.
	listChatCommands: {
		params: Record<string, never>;
		response: { commands: ChatCommandInfo[] };
	};
};

export type ChatMessages = {
	chatDelta: { convId: string; delta: string; traceId?: string };
	chatComplete: { convId: string; traceId?: string };
	chatError: { convId: string; message: string; traceId?: string };
	// UI navigation broadcasts. Emitted by the windowOpen RPC handler
	// when the command palette (or anywhere else) requests opening a
	// named target. Each window listens for the messages relevant to
	// it — the chat window handles uiOpenSettings/uiOpenChannels by
	// toggling its drawer/view, the pensieve window handles
	// uiOpenPensieve by showing/focusing itself, etc.
	uiOpenChat: Record<string, never>;
	uiOpenCommandPalette: Record<string, never>;
	uiOpenSettings: Record<string, never>;
	uiOpenPensieve: Record<string, never>;
	uiOpenActivity: Record<string, never>;
	uiOpenChannels: Record<string, never>;
	uiOpenBrowser: Record<string, never>;
	uiOpenAgents: Record<string, never>;
	uiOpenPet: Record<string, never>;
	// Bun → chat view broadcast: insert this command into the chat
	// composer (and optionally submit). Round-trip pattern — the
	// palette emits chatCommandRun via rpc.send.chatCommandRun, the
	// bun handler re-broadcasts to every window, and the chat view's
	// listener inserts into its composer. This way it doesn't matter
	// whether the palette was opened from the chat window or a sibling
	// window: behaviour is identical.
	chatCommandRun: { command: { text: string; submit: boolean } };
};
