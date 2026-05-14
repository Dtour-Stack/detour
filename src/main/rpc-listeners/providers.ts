import type { DetourRPC } from "../../shared/rpc";

type ProviderChangedPayload = DetourRPC["bun"]["messages"]["providerChanged"];
type ProviderChangedListener = (payload: ProviderChangedPayload) => void;

type ProviderQuotaChangedPayload = DetourRPC["bun"]["messages"]["providerQuotaChanged"];
type ProviderQuotaChangedListener = (payload: ProviderQuotaChangedPayload) => void;

const subscribers = new Set<ProviderChangedListener>();
const quotaSubscribers = new Set<ProviderQuotaChangedListener>();

/**
 * Subscribe to providerChanged push events. Replaces the WS
 * `provider:changed` listener pattern. React components call this in
 * useEffect; the returned function unsubscribes.
 */
export function onProviderChanged(listener: ProviderChangedListener): () => void {
	subscribers.add(listener);
	return () => subscribers.delete(listener);
}

/**
 * Subscribe to providerQuotaChanged push events. Fires whenever a paid-plan
 * cap is recorded or expires on the bun side. Wire this up in any banner
 * or Settings panel that needs to react to live cap state without polling.
 */
export function onProviderQuotaChanged(
	listener: ProviderQuotaChangedListener,
): () => void {
	quotaSubscribers.add(listener);
	return () => quotaSubscribers.delete(listener);
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
		providerQuotaChanged: (payload: ProviderQuotaChangedPayload) => {
			for (const fn of quotaSubscribers) {
				try { fn(payload); } catch (err) {
					console.warn("[rpc/providers] quota listener threw:", err);
				}
			}
		},
	};
}
