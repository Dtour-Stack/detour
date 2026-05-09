import type {
	BrowserCommand,
	BrowserCommandInput,
	BrowserCommandResult,
} from "../../../../shared/index";
import type { RpcDeps } from "../types";

/**
 * Browser-command RPC handlers. Mirrors the HTTP routes
 * `/api/browser/commands*` in src/bun/core/api/server.ts.
 *
 * Browser-command state (the queue, results map, and waiters) lives on
 * the ApiServer instance to keep one source of truth for HTTP + RPC
 * during the migration window. We reach it via the existing
 * `BROWSER_CONTROL_GLOBAL` symbol — the same indirection that
 * `src/bun/plugins/vault-tools/index.ts` uses to enqueue agent commands
 * without holding an ApiServer reference.
 *
 * The HTTP routes still serve any non-migrated callers; both paths read
 * and write the same in-memory queue, so order and dedupe semantics are
 * preserved.
 */

const BROWSER_CONTROL_GLOBAL = Symbol.for("detour.browser.control");

type BrowserControl = {
	enqueue(command: BrowserCommandInput): BrowserCommand;
	enqueueAndWait(command: BrowserCommandInput, timeoutMs?: number): Promise<BrowserCommandResult>;
	list(opts: { after?: string; since?: number }): BrowserCommand[];
	report(commandId: string, result: Omit<BrowserCommandResult, "time">): BrowserCommandResult;
};

function getBrowserControl(): BrowserControl {
	const value = (globalThis as Record<symbol, unknown>)[BROWSER_CONTROL_GLOBAL];
	if (!value || typeof value !== "object") {
		throw new Error("BROWSER_CONTROL_GLOBAL not installed — ApiServer must be running");
	}
	const control = value as Partial<BrowserControl>;
	if (
		typeof control.enqueue !== "function"
		|| typeof control.list !== "function"
		|| typeof control.report !== "function"
	) {
		throw new Error("BROWSER_CONTROL_GLOBAL is missing list/report/enqueue methods");
	}
	return control as BrowserControl;
}

export function browserRequests(_deps: RpcDeps) {
	return {
		browserCommandsList: async (params: { after?: string; since?: number }): Promise<{ commands: BrowserCommand[] }> => {
			const control = getBrowserControl();
			const commands = control.list({
				...(params.after ? { after: params.after } : {}),
				...(typeof params.since === "number" ? { since: params.since } : {}),
			});
			return { commands };
		},
		browserCommandQueue: async (params: BrowserCommandInput): Promise<{ command: BrowserCommand }> => {
			const control = getBrowserControl();
			const command = control.enqueue(params);
			return { command };
		},
		browserCommandReport: async (params: {
			commandId: string;
			result: Omit<BrowserCommandResult, "time">;
		}): Promise<{ result: BrowserCommandResult }> => {
			const control = getBrowserControl();
			const result = control.report(params.commandId, params.result);
			return { result };
		},
	};
}
