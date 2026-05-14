/**
 * Goal RPC schema — Detour's per-room user-goal state surface.
 *
 * Goals live in pensieve (memory rows with type `detour-goal`) but the
 * UI doesn't need to know the storage layer — it reads/writes through
 * these typed RPC requests and re-renders on the `goalChanged` message.
 */

export interface DetourGoalWire {
	id: string;
	roomId: string;
	text: string;
	createdAt: number;
	source: "user-explicit" | "user-implicit" | "agent-set" | "sub-agent" | "import";
	parentGoalId?: string;
	originText?: string;
}

export type GoalsRequests = {
	goalsGetActive: {
		params: { roomId?: string };
		response: { goal: DetourGoalWire | null };
	};
	goalsSetActive: {
		params: { roomId?: string; text: string };
		response: { goal: DetourGoalWire | null };
	};
	goalsClear: {
		params: { roomId?: string };
		response: { cleared: DetourGoalWire | null };
	};
	goalsListArchived: {
		params: { roomId?: string; limit?: number };
		response: { goals: DetourGoalWire[] };
	};
};

export type GoalsMessages = {
	goalChanged: { roomId: string; goal: DetourGoalWire | null };
};
