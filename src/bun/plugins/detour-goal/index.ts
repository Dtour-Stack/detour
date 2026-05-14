/**
 * detour-goal plugin
 *
 * Surfaces Detour's active conversation goal to the planner on every turn,
 * and threads that goal into spawned sub-agents (CREATE_TASK, SPAWN_AGENT)
 * via the orchestrator's `memoryContent` payload.
 *
 *   - `DETOUR_ACTIVE_GOAL` provider (position -90): renders the active
 *     goal block into the planner state. Sits between CHARACTER_ANCHOR
 *     (-100) and CAPABILITIES (-50) so identity → goal → capability is the
 *     reading order the model sees.
 *
 *   - `SET_GOAL` / `CLEAR_GOAL` actions: explicit setter the agent can call
 *     when the user says "actually, the goal is now X" or "we're done with
 *     that, new ask." Avoids relying on implicit goal extraction once the
 *     conversation pivots.
 *
 *   - Action wrappers for `CREATE_TASK` and `SPAWN_AGENT`: a runtime patch
 *     that, just before the orchestrator's handler runs, prepends the
 *     active goal to `memoryContent` so the spawned sub-agent inherits it.
 *     Belt-and-suspenders against the planner forgetting to thread it.
 *
 * Why a runtime wrapper for spawn:
 *   The orchestrator lives in eliza/plugins/plugin-agent-orchestrator (git
 *   submodule). We can't safely edit the spawn-side directly — eliza
 *   upstream changes would clobber it. Wrapping the action handler at
 *   Detour's boot layer keeps the orchestrator pristine while giving us
 *   the guarantee we need.
 */

import {
	ModelType,
	logger,
	type Action,
	type HandlerCallback,
	type HandlerOptions,
	type IAgentRuntime,
	type Memory,
	type Plugin,
	type Provider,
	type ProviderResult,
	type State,
} from "@elizaos/core";
import { GoalService, type DetourGoal } from "../../core/goal-service";

const WRAPPED_FOR_GOAL = Symbol.for("detour.goal.wrappedAction");
const WRAPPED_ACTIONS = new Set(["CREATE_TASK", "SPAWN_AGENT", "START_CODING_TASK"]);

/**
 * Per-plugin context. We can't construct GoalService at module load (needs
 * a PensieveMemoryService + runtime resolver), so the runtime layer sets
 * this once at boot before plugins initialize.
 */
let goalServiceRef: GoalService | null = null;

export function attachGoalService(service: GoalService): void {
	goalServiceRef = service;
}

function getGoalService(): GoalService | null {
	return goalServiceRef;
}

function roomIdOf(message: Memory | undefined): string {
	if (!message) return "";
	const id = message.roomId;
	return typeof id === "string" ? id : "";
}

const goalProvider: Provider = {
	name: "DETOUR_ACTIVE_GOAL",
	description:
		"The user's currently-active conversation objective. Set on the first substantive turn and threaded into every subsequent planner call so the agent stays anchored on what the user actually wants.",
	descriptionCompressed: "active conversation goal + age + source.",
	position: -90,
	get: async (_runtime: IAgentRuntime, message: Memory, _state: State): Promise<ProviderResult> => {
		const service = getGoalService();
		if (!service) return { text: "" };
		const roomId = roomIdOf(message);
		if (!roomId) return { text: "" };
		const goal = await service.getActiveGoal(roomId);
		if (!goal) {
			return {
				text: [
					"ACTIVE GOAL: (none set yet)",
					"On the next substantive turn, derive the user's primary objective and commit to it before invoking actions.",
				].join("\n"),
				values: { goalActive: false },
			};
		}
		return {
			text: service.formatForPrompt(goal),
			values: {
				goalActive: true,
				goalId: goal.id,
				goalText: goal.text,
				goalSource: goal.source,
				goalAgeMs: Date.now() - goal.createdAt,
			},
		};
	},
};

const setGoalAction: Action = {
	name: "SET_GOAL",
	similes: ["UPDATE_GOAL", "DECLARE_GOAL", "COMMIT_TO_GOAL"],
	description:
		"Explicitly set or replace the active conversation goal. Use when the user pivots " +
		"(\"new ask\", \"actually let's do X instead\"), when the implicit extraction got it " +
		"wrong, or when you want to lock in a goal before doing work that will spawn sub-agents. " +
		"Provide the goal as a single imperative sentence (\"Ship a working budget app demo by EOD\").",
	descriptionCompressed: "set/replace the conversation goal.",
	examples: [
		[
			{ name: "{{user1}}", content: { text: "actually forget the dashboard, just get the auth working first" } },
			{
				name: "{{agentName}}",
				content: {
					text: "got it — pivoting. New goal: get auth working end-to-end before touching the dashboard.",
					action: "SET_GOAL",
					goal: "Get auth working end-to-end before touching the dashboard",
				},
			},
		],
	],
	parameters: [
		{
			name: "goal",
			description: "Single imperative sentence describing the user's objective.",
			required: true,
			schema: { type: "string" as const },
		},
	],
	validate: async () => Boolean(getGoalService()),
	handler: async (
		_runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		options?: { parameters?: Record<string, unknown> },
		callback?: HandlerCallback,
	) => {
		const service = getGoalService();
		if (!service) return { success: false, error: "GOAL_SERVICE_UNAVAILABLE" };
		const text = String(options?.parameters?.goal ?? "").trim();
		const roomId = roomIdOf(message);
		if (!text || !roomId) {
			return { success: false, error: "INVALID_GOAL" };
		}
		const goal = await service.setActiveGoal({
			roomId,
			text,
			source: "agent-set",
		});
		if (callback && goal) {
			await callback({ text: `Locked goal: ${goal.text}` });
		}
		return { success: !!goal, ...(goal && { data: { goalId: goal.id, text: goal.text } }) };
	},
};

const clearGoalAction: Action = {
	name: "CLEAR_GOAL",
	similes: ["RESET_GOAL", "DROP_GOAL", "GOAL_DONE"],
	description:
		"Clear the active conversation goal. Use when the user explicitly says they're done " +
		"with the current objective, or when the work is verifiably complete.",
	descriptionCompressed: "clear the conversation goal.",
	examples: [
		[
			{ name: "{{user1}}", content: { text: "we're done with that one, thanks" } },
			{
				name: "{{agentName}}",
				content: {
					text: "Clearing the active goal. Ready for the next thing.",
					action: "CLEAR_GOAL",
				},
			},
		],
	],
	parameters: [],
	validate: async () => Boolean(getGoalService()),
	handler: async (
		_runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		_options?: unknown,
		callback?: HandlerCallback,
	) => {
		const service = getGoalService();
		if (!service) return { success: false, error: "GOAL_SERVICE_UNAVAILABLE" };
		const roomId = roomIdOf(message);
		if (!roomId) return { success: false, error: "NO_ROOM" };
		const cleared = await service.clearActiveGoal(roomId);
		if (callback) {
			await callback({
				text: cleared ? `Cleared goal: ${cleared.text}` : "No active goal to clear.",
			});
		}
		return { success: true, ...(cleared && { data: { previous: cleared.text } }) };
	},
};

interface SpawnParams {
	memoryContent?: unknown;
	[key: string]: unknown;
}

interface SpawnContent {
	memoryContent?: unknown;
	[key: string]: unknown;
}

function injectGoalIntoMemoryContent(
	existing: string | undefined,
	goal: DetourGoal,
	service: GoalService,
): string {
	const header = service.formatForSubAgent(goal);
	const trimmed = (existing ?? "").trim();
	if (!trimmed) return header;
	if (trimmed.includes(`Goal id: ${goal.id}`)) return trimmed;
	return `${header}\n\n---\n\n${trimmed}`;
}

/**
 * Wrap a single Action's handler so it injects the active goal into the
 * spawn payload's `memoryContent` field. Idempotent — re-wrapping is a
 * no-op via the WRAPPED_FOR_GOAL marker.
 *
 * Trade-off: we mutate `message.content.memoryContent` and (if provided)
 * `options.parameters.memoryContent`. The eliza runtime treats these
 * payloads as transient (built per-turn by the planner) so mutation is
 * safe and avoids re-allocating the entire Memory.
 */
function wrapSpawnAction(action: Action): Action {
	const marker = action as Action & { [WRAPPED_FOR_GOAL]?: true };
	if (marker[WRAPPED_FOR_GOAL]) return action;
	const original = action.handler;
	if (typeof original !== "function") return action;
	const patched: Action["handler"] = async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
		responses?: Memory[],
	) => {
		const service = getGoalService();
		const roomId = roomIdOf(message);
		if (service && roomId) {
			try {
				const goal = await service.getActiveGoal(roomId);
				if (goal) {
					const content = (message.content as SpawnContent) ?? {};
					const existing =
						typeof content.memoryContent === "string"
							? (content.memoryContent as string)
							: undefined;
					const merged = injectGoalIntoMemoryContent(existing, goal, service);
					(message.content as SpawnContent).memoryContent = merged;
					const params = options?.parameters as SpawnParams | undefined;
					if (params) {
						const existingParam =
							typeof params.memoryContent === "string"
								? (params.memoryContent as string)
								: undefined;
						params.memoryContent = injectGoalIntoMemoryContent(existingParam, goal, service);
					}
					logger.info(
						{ src: "detour:goal", action: action.name, goalId: goal.id },
						"Threaded active goal into sub-agent spawn",
					);
				}
			} catch (err) {
				logger.warn(
					{ src: "detour:goal", err: err instanceof Error ? err.message : err },
					"Goal threading failed — proceeding with original spawn payload",
				);
			}
		}
		return original.call(action, runtime, message, state, options, callback, responses);
	};
	(action as { handler: Action["handler"] }).handler = patched;
	marker[WRAPPED_FOR_GOAL] = true;
	return action;
}

/**
 * Walk the runtime's actions and wrap each spawn-style action. Idempotent
 * via the WRAPPED_FOR_GOAL marker, so calling this from both plugin init
 * AND from a RuntimeService onAfterBuild hook is safe — the second call
 * will find the actions already wrapped and skip them.
 *
 * Why both: init runs before the orchestrator's PTYService finishes its
 * async startup (it might fail and re-attempt, or take a few seconds on
 * cold start). onAfterBuild runs once the runtime is fully assembled, so
 * it's the guaranteed pass that catches actions registered after init.
 */
export function wrapSpawnActionsOnRuntime(runtime: IAgentRuntime): void {
	const actions = (runtime as unknown as { actions?: Action[] }).actions;
	if (!Array.isArray(actions)) return;
	for (const action of actions) {
		if (WRAPPED_ACTIONS.has(action.name)) {
			wrapSpawnAction(action);
		}
	}
}

export const detourGoalPlugin: Plugin = {
	name: "detour-goal",
	description:
		"Captures the user's active conversation goal, surfaces it on every planner turn, and threads it into spawned sub-agents so multi-step work stays anchored on the user's intent.",
	providers: [goalProvider],
	actions: [setGoalAction, clearGoalAction],
	init: async (_config, runtime) => {
		// Best-effort first pass — most actions are registered by now and
		// this catches them before the runtime's first turn. The guaranteed
		// pass runs in core/index.ts via runtime.onAfterBuild AFTER all
		// services have started (including the orchestrator).
		wrapSpawnActionsOnRuntime(runtime);
	},
};

export { goalProvider, setGoalAction, clearGoalAction };

// Touch ModelType so the import isn't pruned when the action-handler types
// are externally inferred. The provider lives here for cohesion; future
// extraction-from-context calls will use TEXT_SMALL on the same path.
void ModelType;
