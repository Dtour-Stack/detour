/**
 * Cross-surface context for Detour-style plain-text planner fallbacks.
 *
 * Node: AsyncLocalStorage so `dynamicPromptExecFromState` patches can tell
 * whether the current turn is "addressed" (Discord @-mention, Telegram reply
 * path with auto-reply, etc.). Browser: stack fallback (same pattern as
 * trajectory-context).
 */
export interface PlannerReplyContext {
	source: string;
	addressed: boolean;
}

/** `State.values` key — snapshot from ALS at compose time for DPE / late async paths. */
export const PLANNER_REPLY_CONTEXT_SNAPSHOT_STATE_KEY =
	"plannerReplyContextSnapshot" as const;

export interface IPlannerReplyContextManager {
	run<T>(context: PlannerReplyContext | undefined, fn: () => T | Promise<T>): T | Promise<T>;
	active(): PlannerReplyContext | undefined;
}

class StackPlannerReplyContextManager implements IPlannerReplyContextManager {
	private stack: Array<PlannerReplyContext | undefined> = [];

	run<T>(
		context: PlannerReplyContext | undefined,
		fn: () => T | Promise<T>,
	): T | Promise<T> {
		this.stack.push(context);
		let syncPop = true;
		try {
			const result = fn();
			if (
				result !== null &&
				typeof result === "object" &&
				"then" in result &&
				typeof (result as PromiseLike<unknown>).then === "function"
			) {
				syncPop = false;
				return (result as Promise<T>).finally(() => {
					this.stack.pop();
				});
			}
			return result;
		} finally {
			if (syncPop) this.stack.pop();
		}
	}

	active(): PlannerReplyContext | undefined {
		return this.stack.length > 0
			? this.stack[this.stack.length - 1]
			: undefined;
	}
}

let globalPlannerReplyManager: IPlannerReplyContextManager | null = null;
const PLANNER_REPLY_CONTEXT_MANAGER_KEY = Symbol.for(
	"elizaos.plannerReplyContextManager",
);

type GlobalWithPlannerReplyContextManager = typeof globalThis & {
	[PLANNER_REPLY_CONTEXT_MANAGER_KEY]?: IPlannerReplyContextManager;
};

function isNodeEnvironment(): boolean {
	return (
		typeof process !== "undefined" &&
		typeof process.versions !== "undefined" &&
		typeof process.versions.node !== "undefined"
	);
}

function initPlannerReplyManagerSync(): IPlannerReplyContextManager {
	if (isNodeEnvironment()) {
		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const { AsyncLocalStorage } =
				require("node:async_hooks") as typeof import("node:async_hooks");
			const storage = new AsyncLocalStorage<
				PlannerReplyContext | undefined
			>();
			return {
				run<T>(
					context: PlannerReplyContext | undefined,
					fn: () => T | Promise<T>,
				): T | Promise<T> {
					return storage.run(context, fn);
				},
				active(): PlannerReplyContext | undefined {
					return storage.getStore();
				},
			} as IPlannerReplyContextManager;
		} catch {
			// AsyncLocalStorage unavailable — fall back to stack
		}
	}
	return new StackPlannerReplyContextManager();
}

function getOrCreatePlannerReplyManager(): IPlannerReplyContextManager {
	if (!globalPlannerReplyManager) {
		const globalManager = (globalThis as GlobalWithPlannerReplyContextManager)[
			PLANNER_REPLY_CONTEXT_MANAGER_KEY
		];
		if (globalManager) {
			globalPlannerReplyManager = globalManager;
		} else {
			globalPlannerReplyManager = initPlannerReplyManagerSync();
			(globalThis as GlobalWithPlannerReplyContextManager)[
				PLANNER_REPLY_CONTEXT_MANAGER_KEY
			] = globalPlannerReplyManager;
		}
	}
	return globalPlannerReplyManager;
}

export function setPlannerReplyContextManager(
	manager: IPlannerReplyContextManager,
): void {
	globalPlannerReplyManager = manager;
	(globalThis as GlobalWithPlannerReplyContextManager)[
		PLANNER_REPLY_CONTEXT_MANAGER_KEY
	] = manager;
}

export function getPlannerReplyContextManager(): IPlannerReplyContextManager {
	return getOrCreatePlannerReplyManager();
}

export function runWithPlannerReplyContext<T>(
	context: PlannerReplyContext | undefined,
	fn: () => T | Promise<T>,
): T | Promise<T> {
	return getOrCreatePlannerReplyManager().run(context, fn);
}

export function getPlannerReplyContext(): PlannerReplyContext | undefined {
	return getOrCreatePlannerReplyManager().active();
}
