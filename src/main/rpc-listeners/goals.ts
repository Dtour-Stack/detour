import type { DetourRPC } from "../../shared/rpc";

type GoalChangedPayload = DetourRPC["bun"]["messages"]["goalChanged"];
type Listener = (payload: GoalChangedPayload) => void;

const subscribers = new Set<Listener>();

export function onGoalChanged(listener: Listener): () => void {
	subscribers.add(listener);
	return () => subscribers.delete(listener);
}

export function goalsMessages() {
	return {
		goalChanged: (payload: GoalChangedPayload) => {
			for (const fn of subscribers) {
				try {
					fn(payload);
				} catch (err) {
					console.warn("[rpc/goals] listener threw:", err);
				}
			}
		},
	};
}
