import { runWindowCommand } from "../window-controller-registry";
import type { RpcDeps } from "../types";
import type { WindowOpenTarget } from "../../../../shared/index";

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
 *
 * windowOpen broadcasts a uiOpen* message keyed by target. Each
 * window's view-side listener handles the message relevant to it
 * (chat window toggles its drawer for settings; pensieve
 * window shows itself on uiOpenPensieve; etc.). Targets without a
 * dedicated window in the current build (e.g. agents, pet) still
 * broadcast — those features will pick the message up once they
 * land.
 */

const WINDOW_OPEN_MESSAGE: Record<WindowOpenTarget, keyof import("../../../../shared/rpc/chat").ChatMessages> = {
	chat: "uiOpenChat",
	"command-palette": "uiOpenCommandPalette",
	settings: "uiOpenSettings",
	pensieve: "uiOpenPensieve",
	activity: "uiOpenActivity",
	browser: "uiOpenBrowser",
	agents: "uiOpenAgents",
	pet: "uiOpenPet",
	gallery: "uiOpenGallery",
	portless: "uiOpenPortless",
};

export function windowRequests(deps: RpcDeps) {
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
		windowOpen: async (params: { target: WindowOpenTarget }): Promise<{ ok: true }> => {
			const messageName = WINDOW_OPEN_MESSAGE[params.target];
			if (messageName) {
				deps.broadcaster.broadcast(messageName, {});
			}
			return { ok: true };
		},
	};
}
