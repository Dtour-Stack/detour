/**
 * Inbox RPC handlers. Mirror /api/inbox/* in src/bun/core/api/server.ts.
 *
 *   - inboxList              → InboxService.list({ status?, kind?, limit? })
 *   - inboxPostNotification  → InboxService.post({ kind: "notification", ... })
 *   - inboxUpdateStatus      → InboxService.updateStatus() [throws on miss]
 *   - inboxAct               → InboxService.act()          [throws on miss]
 *
 * `inboxPostNotification` always sets `kind: "notification"` to match the
 * existing WebClient wire (the HTTP route accepts arbitrary kinds, but no
 * call site uses anything other than notification).
 */

import type { InboxItem, InboxStatus } from "../../inbox";
import type { RpcDeps } from "../types";
import type {
	InboxListOptions,
	InboxPostNotificationInput,
} from "../../../../shared/rpc/inbox";

export function inboxRequests(deps: RpcDeps) {
	return {
		inboxList: async (params: InboxListOptions): Promise<{ items: InboxItem[]; total: number }> => {
			return deps.inbox.list({
				...(params.status ? { status: params.status } : {}),
				...(params.kind ? { kind: params.kind } : {}),
				...(params.limit ? { limit: params.limit } : {}),
			});
		},
		inboxPostNotification: async (
			params: InboxPostNotificationInput,
		): Promise<{ ok: true; item: InboxItem }> => {
			if (!params.title) throw new Error("title required");
			const item = await deps.inbox.post({
				kind: "notification",
				title: params.title,
				body: params.body ?? "",
				...(params.prompt !== undefined ? { prompt: params.prompt } : {}),
			});
			return { ok: true, item };
		},
		inboxUpdateStatus: async (
			params: { id: string; status: InboxStatus },
		): Promise<{ ok: true; item: InboxItem }> => {
			const updated = deps.inbox.updateStatus(params.id, params.status);
			if (!updated) throw new Error("inbox item not found");
			return { ok: true, item: updated };
		},
		inboxAct: async (params: { id: string }): Promise<{ ok: true; item: InboxItem }> => {
			const updated = await deps.inbox.act(params.id);
			if (!updated) throw new Error("inbox item not found");
			return { ok: true, item: updated };
		},
	};
}
