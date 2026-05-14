/**
 * GoalService — Detour's explicit user-goal layer.
 *
 * What "goal" means at this layer:
 *   The user-facing objective for the current conversation/turn. Distinct from
 *   the orchestrator's `kind: "goal"` thread nodes (those live inside a
 *   spawned multi-agent task graph). This is the higher-level intent that
 *   frames everything Detour does for the user — and that needs to be
 *   threaded into any sub-agent Detour spawns.
 *
 * Why it exists:
 *   Per user feedback (lost funding, "LARP" behavior): the agent should
 *   commit to an explicit goal up front, get clarity ONCE, then drive
 *   relentlessly toward it. Sub-agents spawned via CREATE_TASK / SPAWN_AGENT
 *   must inherit that goal so they don't drift onto adjacent work.
 *
 * Storage:
 *   Goals are persisted as memories at path `/goals/<roomId>` with
 *   metadata.type = `detour-goal` and metadata.tags including `goal:active`
 *   for the current one and `goal:archived` for previous ones in the room.
 *   Reusing pensieve's memory table avoids a new schema and means goals show
 *   up in the existing Pensieve UI for free.
 *
 * Lifecycle:
 *   1. User sends a turn.
 *   2. `ensureGoalForTurn` checks for active goal in this room.
 *   3. If absent: extract one with TEXT_SMALL (single call, no recursion),
 *      persist, return.
 *   4. If present: return as-is. The provider surfaces it to the planner;
 *      the action wrapper threads it into spawned sub-agents.
 *
 *   Re-extraction across turns is NOT done automatically — only when the
 *   user explicitly clears, or when an agent action sets a fresh goal. This
 *   matches the user's explicit "get clarity once, then proceed" rule.
 */

import {
	ModelType,
	logger,
	type IAgentRuntime,
	type UUID,
} from "@elizaos/core";
import type { PensieveMemoryService, PensieveMemorySummary } from "./pensieve/memory-service";
import {
	DETOUR_GOAL_EXTRACTION_DEFAULT,
	DETOUR_GOAL_EXTRACTION_TEMPLATE,
	renderPromptTemplate,
} from "./prompt-templates";

export const GOAL_MEMORY_TYPE = "detour-goal";
export const GOAL_TAG_ACTIVE = "goal:active";
export const GOAL_TAG_ARCHIVED = "goal:archived";
export const GOAL_PATH_PREFIX = "/goals";

export type GoalSource =
	| "user-explicit"
	| "user-implicit"
	| "agent-set"
	| "sub-agent"
	| "import";

export interface DetourGoal {
	id: string;
	roomId: string;
	text: string;
	createdAt: number;
	source: GoalSource;
	parentGoalId?: string;
	/** Original user text that the goal was extracted from (for audit). */
	originText?: string;
}

export interface SetGoalInput {
	roomId: string;
	text: string;
	source: GoalSource;
	parentGoalId?: string;
	originText?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function summaryToGoal(summary: PensieveMemorySummary, fullText: string | null): DetourGoal | null {
	const tags = summary.tags ?? [];
	if (!tags.includes(GOAL_TAG_ACTIVE) && !tags.includes(GOAL_TAG_ARCHIVED)) return null;
	const roomId = summary.roomId ?? "";
	if (!roomId) return null;
	const text = (fullText ?? summary.preview).trim();
	if (!text) return null;
	return {
		id: summary.id,
		roomId,
		text,
		createdAt: summary.createdAt ?? Date.now(),
		source: "user-implicit",
	};
}

function goalPath(roomId: string): string {
	return `${GOAL_PATH_PREFIX}/${roomId}`;
}

function compactOne(text: string, max = 400): string {
	return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function looksLikeChitchat(text: string): boolean {
	const t = text.trim().toLowerCase();
	if (t.length === 0) return true;
	if (t.length < 10) return true;
	if (/^(hi|hey|yo|hello|sup|gm|gn|thanks?|ty|ok|okay|cool|nice|lol|lmao)\b/.test(t)) {
		return true;
	}
	return false;
}

export class GoalService {
	private extractionInFlight: Map<string, Promise<DetourGoal | null>> = new Map();

	constructor(
		private readonly resolveRuntime: () => IAgentRuntime | null,
		private readonly memories: PensieveMemoryService,
	) {}

	/**
	 * Return the active goal for a room, or null when none. Reads the most
	 * recent memory tagged `goal:active` under `/goals/<roomId>`.
	 */
	async getActiveGoal(roomId: string): Promise<DetourGoal | null> {
		if (!roomId) return null;
		const rows = await this.memories.list({
			type: GOAL_MEMORY_TYPE,
			tag: GOAL_TAG_ACTIVE,
			pathPrefix: goalPath(roomId),
			limit: 5,
		});
		const matching = rows.filter((row) => row.roomId === roomId);
		if (matching.length === 0) return null;
		const top = matching[0];
		if (!top) return null;
		const detail = await this.memories.get(top.id as UUID);
		const fullText =
			typeof detail?.content?.text === "string" ? detail.content.text : null;
		const md = asRecord(detail?.metadata);
		const sourceRaw = md ? md.goalSource : undefined;
		const source =
			typeof sourceRaw === "string" && isGoalSource(sourceRaw) ? sourceRaw : "user-implicit";
		const parentGoalId =
			md && typeof md.parentGoalId === "string" ? (md.parentGoalId as string) : undefined;
		const originText =
			md && typeof md.originText === "string" ? (md.originText as string) : undefined;
		return {
			id: top.id,
			roomId,
			text: (fullText ?? top.preview).trim(),
			createdAt: top.createdAt ?? Date.now(),
			source,
			...(parentGoalId !== undefined && { parentGoalId }),
			...(originText !== undefined && { originText }),
		};
	}

	/**
	 * List previous (archived) goals for a room, newest first. Used in the
	 * Pensieve UI history pane and by the dream service to reason over
	 * what the user has historically wanted.
	 */
	async listArchivedGoals(roomId: string, limit = 20): Promise<DetourGoal[]> {
		if (!roomId) return [];
		const rows = await this.memories.list({
			type: GOAL_MEMORY_TYPE,
			tag: GOAL_TAG_ARCHIVED,
			pathPrefix: goalPath(roomId),
			limit,
		});
		const out: DetourGoal[] = [];
		for (const row of rows) {
			if (row.roomId !== roomId) continue;
			const detail = await this.memories.get(row.id as UUID);
			const fullText =
				typeof detail?.content?.text === "string" ? detail.content.text : row.preview;
			const goal = summaryToGoal(row, fullText);
			if (goal) out.push(goal);
		}
		return out;
	}

	/**
	 * Set (or replace) the active goal for a room. Marks any existing active
	 * goal as archived first so there's never more than one active per room.
	 * Idempotent: a no-op when the new text equals the current active text.
	 */
	async setActiveGoal(input: SetGoalInput): Promise<DetourGoal | null> {
		const text = compactOne(input.text);
		if (!text) return null;
		const current = await this.getActiveGoal(input.roomId);
		if (current && current.text === text) {
			return current;
		}
		if (current) {
			await this.archiveGoal(current.id);
		}
		const extraMetadata: Record<string, unknown> = {
			goalSource: input.source,
		};
		if (input.parentGoalId) extraMetadata.parentGoalId = input.parentGoalId;
		if (input.originText) extraMetadata.originText = input.originText.slice(0, 2000);

		const created = await this.memories.create({
			text,
			path: goalPath(input.roomId),
			type: GOAL_MEMORY_TYPE,
			tags: [GOAL_TAG_ACTIVE],
			roomId: input.roomId,
			extraMetadata,
		});
		if (!created) {
			logger.warn(
				{ src: "detour:goal", roomId: input.roomId },
				"Failed to persist goal — pensieve memory create returned null",
			);
			return null;
		}
		logger.info(
			{ src: "detour:goal", id: created.id, roomId: input.roomId, source: input.source },
			"Active goal set",
		);
		return {
			id: created.id,
			roomId: input.roomId,
			text,
			createdAt: Date.now(),
			source: input.source,
			...(input.parentGoalId !== undefined && { parentGoalId: input.parentGoalId }),
			...(input.originText !== undefined && { originText: input.originText }),
		};
	}

	/**
	 * Clear the room's active goal. Returns the archived goal text (so the
	 * UI can show "cleared X") or null when no goal was set.
	 */
	async clearActiveGoal(roomId: string): Promise<DetourGoal | null> {
		const current = await this.getActiveGoal(roomId);
		if (!current) return null;
		await this.archiveGoal(current.id);
		return current;
	}

	/**
	 * Run on each turn before planning. If there's no active goal for the
	 * room AND the user message looks substantive (not chitchat), extract
	 * one with a small model and persist it. Returns the active goal (new
	 * or existing) so the caller can render it into the planner state.
	 *
	 * Concurrency: per-room single-flight. Two near-simultaneous turns from
	 * the same channel (e.g. user spamming) won't trigger duplicate goal
	 * extractions — the second turn observes the in-flight promise.
	 */
	async ensureGoalForTurn(roomId: string, userText: string): Promise<DetourGoal | null> {
		const existing = await this.getActiveGoal(roomId);
		if (existing) return existing;
		if (looksLikeChitchat(userText)) return null;
		const cached = this.extractionInFlight.get(roomId);
		if (cached) return cached;
		const promise = this.extractAndSet(roomId, userText).finally(() => {
			this.extractionInFlight.delete(roomId);
		});
		this.extractionInFlight.set(roomId, promise);
		return promise;
	}

	/**
	 * Format an active goal for inclusion in the planner prompt. Returns an
	 * empty string when no goal is set so callers can unconditionally
	 * concatenate.
	 */
	formatForPrompt(goal: DetourGoal | null): string {
		if (!goal) return "";
		const ageMs = Date.now() - goal.createdAt;
		const ageMin = Math.max(0, Math.round(ageMs / 60_000));
		return [
			"ACTIVE GOAL (commit to this; stop only when achieved or user clears it):",
			goal.text,
			`(set ${ageMin}m ago via ${goal.source})`,
		].join("\n");
	}

	/**
	 * Format a goal for hand-off to a sub-agent. Heavier than the planner
	 * format — gives the sub-agent enough framing to keep its work aligned
	 * with the user's intent rather than drifting into "while I'm here"
	 * scope.
	 */
	formatForSubAgent(goal: DetourGoal | null): string {
		if (!goal) return "";
		return [
			"# Parent goal (inherited from Detour)",
			"",
			`The user's overall objective for this conversation is:`,
			"",
			`> ${goal.text}`,
			"",
			"This sub-task is one step toward that goal. When you make scope or",
			"verification decisions, anchor on this. If you discover a related",
			"problem, NOTE IT FOR THE USER but do not silently expand scope.",
			`Goal id: ${goal.id} (parent goal threading)`,
		].join("\n");
	}

	private async extractAndSet(roomId: string, userText: string): Promise<DetourGoal | null> {
		const runtime = this.resolveRuntime();
		if (!runtime) return null;
		const prompt = renderPromptTemplate(
			runtime,
			DETOUR_GOAL_EXTRACTION_TEMPLATE,
			{ userMessage: userText.slice(0, 2000) },
			DETOUR_GOAL_EXTRACTION_DEFAULT,
		);
		let raw: unknown;
		try {
			raw = await runtime.useModel(ModelType.TEXT_SMALL, {
				prompt,
				maxTokens: 120,
				temperature: 0.1,
			});
		} catch (err) {
			logger.warn(
				{ src: "detour:goal", err: err instanceof Error ? err.message : err },
				"Goal extraction model call failed",
			);
			return null;
		}
		const text = typeof raw === "string" ? raw : "";
		const cleaned = compactOne(text.replace(/^["'`]+|["'`]+$/g, ""));
		if (!cleaned || cleaned.toUpperCase() === "NONE") return null;
		return this.setActiveGoal({
			roomId,
			text: cleaned,
			source: "user-implicit",
			originText: userText,
		});
	}

	private async archiveGoal(id: string): Promise<void> {
		const detail = await this.memories.get(id as UUID);
		if (!detail) return;
		const existing = detail.tags ?? [];
		const nextTags = [
			...existing.filter((tag) => tag !== GOAL_TAG_ACTIVE),
			GOAL_TAG_ARCHIVED,
		];
		await this.memories.update(id as UUID, { tags: nextTags });
	}
}

function isGoalSource(value: string): value is GoalSource {
	return (
		value === "user-explicit" ||
		value === "user-implicit" ||
		value === "agent-set" ||
		value === "sub-agent" ||
		value === "import"
	);
}
