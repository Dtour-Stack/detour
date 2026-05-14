import type { DetourRPC } from "../../shared/rpc";

type DreamChangedPayload = DetourRPC["bun"]["messages"]["dreamChanged"];
type Listener = (payload: DreamChangedPayload) => void;

const subscribers = new Set<Listener>();

export function onDreamChanged(listener: Listener): () => void {
	subscribers.add(listener);
	return () => subscribers.delete(listener);
}

export function dreamsMessages() {
	return {
		dreamChanged: (payload: DreamChangedPayload) => {
			for (const fn of subscribers) {
				try {
					fn(payload);
				} catch (err) {
					console.warn("[rpc/dreams] listener threw:", err);
				}
			}
		},
	};
}
