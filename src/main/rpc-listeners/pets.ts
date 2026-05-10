import type { DetourRPC } from "../../shared/rpc";

type StatePayload = DetourRPC["bun"]["messages"]["petState"];

const stateSubs = new Set<(p: StatePayload) => void>();

export function onPetState(fn: (p: StatePayload) => void): () => void {
	stateSubs.add(fn);
	return () => stateSubs.delete(fn);
}

function fanout<P>(subs: Set<(p: P) => void>, payload: P, label: string): void {
	for (const fn of subs) {
		try {
			fn(payload);
		} catch (err) {
			console.warn(`[rpc/${label}] listener threw:`, err);
		}
	}
}

export function petsMessages() {
	return {
		petState: (payload: StatePayload) => fanout(stateSubs, payload, "petState"),
	};
}
