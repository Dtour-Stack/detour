import type { DetourRPC } from "../../shared/rpc";

type BackendChangedPayload = DetourRPC["bun"]["messages"]["backendChanged"];
type BackendChangedListener = (payload: BackendChangedPayload) => void;

const subscribers = new Set<BackendChangedListener>();

export function onBackendChanged(listener: BackendChangedListener): () => void {
	subscribers.add(listener);
	return () => subscribers.delete(listener);
}

export function vaultMessages() {
	return {
		backendChanged: (payload: BackendChangedPayload) => {
			for (const fn of subscribers) {
				try { fn(payload); } catch (err) {
					console.warn("[rpc/vault] listener threw:", err);
				}
			}
		},
	};
}
