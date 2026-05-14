/**
 * Goal RPC handlers.
 *
 *   - goalsGetActive    → GoalService.getActiveGoal
 *   - goalsSetActive    → GoalService.setActiveGoal (source: user-explicit)
 *   - goalsClear        → GoalService.clearActiveGoal
 *   - goalsListArchived → GoalService.listArchivedGoals
 *
 * `roomId` defaults to the tray-app's canonical chat room so the dashboard
 * banner doesn't need to know room ids. Other channels (Discord, Telegram,
 * iMessage) pass their channel room id explicitly.
 */

import { stringToUuid } from "@elizaos/core";
import type { RpcDeps } from "../types";
import type { DetourGoal } from "../../goal-service";
import type { DetourGoalWire } from "../../../../shared/rpc/goals";

const DEFAULT_ROOM_ID = String(stringToUuid("tray-app:default-room"));

function toWire(goal: DetourGoal | null): DetourGoalWire | null {
	if (!goal) return null;
	return {
		id: goal.id,
		roomId: goal.roomId,
		text: goal.text,
		createdAt: goal.createdAt,
		source: goal.source,
		...(goal.parentGoalId !== undefined && { parentGoalId: goal.parentGoalId }),
		...(goal.originText !== undefined && { originText: goal.originText }),
	};
}

function resolveRoomId(roomId: string | undefined): string {
	const trimmed = (roomId ?? "").trim();
	return trimmed.length > 0 ? trimmed : DEFAULT_ROOM_ID;
}

export function goalsRequests(deps: RpcDeps) {
	const broadcast = (roomId: string, goal: DetourGoal | null): void => {
		deps.broadcaster.broadcast("goalChanged", { roomId, goal: toWire(goal) });
	};
	return {
		goalsGetActive: async (params: { roomId?: string }): Promise<{ goal: DetourGoalWire | null }> => {
			const roomId = resolveRoomId(params.roomId);
			return { goal: toWire(await deps.goal.getActiveGoal(roomId)) };
		},
		goalsSetActive: async (
			params: { roomId?: string; text: string },
		): Promise<{ goal: DetourGoalWire | null }> => {
			const roomId = resolveRoomId(params.roomId);
			const text = String(params.text ?? "").trim();
			if (!text) throw new Error("goal text required");
			const goal = await deps.goal.setActiveGoal({
				roomId,
				text,
				source: "user-explicit",
			});
			broadcast(roomId, goal);
			return { goal: toWire(goal) };
		},
		goalsClear: async (
			params: { roomId?: string },
		): Promise<{ cleared: DetourGoalWire | null }> => {
			const roomId = resolveRoomId(params.roomId);
			const cleared = await deps.goal.clearActiveGoal(roomId);
			broadcast(roomId, null);
			return { cleared: toWire(cleared) };
		},
		goalsListArchived: async (
			params: { roomId?: string; limit?: number },
		): Promise<{ goals: DetourGoalWire[] }> => {
			const roomId = resolveRoomId(params.roomId);
			const goals = await deps.goal.listArchivedGoals(roomId, params.limit);
			return { goals: goals.flatMap((g) => (toWire(g) ? [toWire(g) as DetourGoalWire] : [])) };
		},
	};
}
