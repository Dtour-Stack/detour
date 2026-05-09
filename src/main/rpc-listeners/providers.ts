import type { DetourRPC } from "../../shared/rpc";

type ProviderChangedPayload = DetourRPC["bun"]["messages"]["providerChanged"];
type ProviderChangedListener = (payload: ProviderChangedPayload) => void;

const subscribers = new Set<ProviderChangedListener>();

/**
 * Subscribe to providerChanged push events. Replaces the WS
 * `provider:changed` listener pattern. React components call this in
 * useEffect; the returned function unsubscribes.
 */
export function onProviderChanged(listener: ProviderChangedListener): () => void {
	subscribers.add(listener);
	return () => subscribers.delete(listener);
}

export function providersMessages() {
	return {
		providerChanged: (payload: ProviderChangedPayload) => {
			for (const fn of subscribers) {
				try { fn(payload); } catch (err) {
					console.warn("[rpc/providers] listener threw:", err);
				}
			}
		},
	};
}
