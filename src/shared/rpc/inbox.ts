/**
 * Inbox RPC (notifications + actionable channel signals). Wire shapes
 * match the legacy HTTP routes 1:1:
 *
 *   GET    /api/inbox?status&kind&limit → inboxList → { items, total }
 *   POST   /api/inbox                   → inboxPostNotification
 *     body { kind, title, body, prompt? } → { ok, item }
 *   PATCH  /api/inbox/<id>/status       → inboxUpdateStatus
 *     body { status } → { ok, item }
 *   POST   /api/inbox/<id>/act          → inboxAct → { ok, item }
 *
 * `not found` (HTTP 404 from updateStatus / act) is signaled by the
 * handler throwing — RPC has no status codes.
 *
 * The list filter is intentionally narrowed to status / kind / limit to
 * match the call sites' needs (the bun-side service supports more —
 * source/channel/since — but no current view exercises them).
 */

// Single source of truth for the inbox wire shapes. The bun-side inbox service
// imports these back from here (shared is a leaf — it must not depend on bun).
export type InboxKind = "message" | "notification" | "identity-conflict" | "task" | "event";
export type InboxStatus = "pending" | "acting" | "acknowledged" | "acted" | "dismissed";

export interface InboxItem {
	readonly id: string;
	readonly time: number;
	readonly kind: InboxKind;
	readonly status: InboxStatus;
	readonly title: string;
	readonly body: string;
	readonly source: string;
	readonly channel?: string;
	readonly fromHandle?: string;
	readonly entityId?: string;
	readonly prompted?: boolean;
	readonly replyText?: string;
	readonly meta?: Record<string, unknown>;
}

export type InboxListOptions = {
	status?: InboxStatus;
	kind?: InboxKind;
	limit?: number;
};

export type InboxPostNotificationInput = {
	title: string;
	body: string;
	prompt?: boolean;
};

export type InboxRequests = {
	inboxList: {
		params: InboxListOptions;
		response: { items: InboxItem[]; total: number };
	};
	inboxPostNotification: {
		params: InboxPostNotificationInput;
		response: { ok: true; item: InboxItem };
	};
	inboxUpdateStatus: {
		params: { id: string; status: InboxStatus };
		response: { ok: true; item: InboxItem };
	};
	inboxAct: {
		params: { id: string };
		response: { ok: true; item: InboxItem };
	};
};
