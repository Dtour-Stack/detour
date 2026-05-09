import { runWindowCommand } from "../window-controller-registry";
import type { RpcDeps } from "../types";

/**
 * Window control for the chat popup. The chat feature registers a
 * WindowController on both the legacy ApiServer (for HTTP /api/window/*)
 * and the typed-RPC registry (for these handlers); both transports run
 * through the same callback so behavior is identical.
 *
 * Replaces:
 *   - POST /api/window/hide   → windowHide
 *   - POST /api/window/pin    → windowPin
 *   - POST /api/window/resize → windowResize
 */
export function windowRequests(_deps: RpcDeps) {
	return {
		windowHide: async (_params: Record<string, never>): Promise<{ ok: true }> => {
			runWindowCommand({ kind: "hide" });
			return { ok: true };
		},
		windowPin: async (params: { on: boolean }): Promise<{ ok: true }> => {
			runWindowCommand({ kind: "pin", on: !!params.on });
			return { ok: true };
		},
		windowResize: async (params: { width: number; height: number }): Promise<{ ok: true }> => {
			runWindowCommand({
				kind: "resize",
				width: Math.max(320, Math.min(2000, Number(params.width) || 0)),
				height: Math.max(320, Math.min(2000, Number(params.height) || 0)),
			});
			return { ok: true };
		},
	};
}
