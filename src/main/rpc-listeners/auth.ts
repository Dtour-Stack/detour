import type { DetourRPC } from "../../shared/rpc";

type AuthFlowUpdatePayload = DetourRPC["bun"]["messages"]["authFlowUpdate"];
type AuthFlowUpdateListener = (payload: AuthFlowUpdatePayload) => void;

const subscribers = new Set<AuthFlowUpdateListener>();

/**
 * Subscribe to authFlowUpdate push events. Replaces the WS
 * `auth:flow-update` listener pattern. React components call this in
 * useEffect; the returned function unsubscribes.
 *
 * The OAuth-driving UI (`ProvidersTab`) typically subscribes once on
 * mount and filters payloads by `sessionId` via functional setState.
 * The flow's `subscribeFlow` is registered server-side immediately
 * after `startFlow` resolves — well before the first `pending → *`
 * transition can fire — so a single mount-time subscription is safe.
 */
export function onAuthFlowUpdate(listener: AuthFlowUpdateListener): () => void {
	subscribers.add(listener);
	return () => subscribers.delete(listener);
}

export function authMessages() {
	return {
		authFlowUpdate: (payload: AuthFlowUpdatePayload) => {
			for (const fn of subscribers) {
				try {
					fn(payload);
				} catch (err) {
					console.warn("[rpc/auth] listener threw:", err);
				}
			}
		},
	};
}
