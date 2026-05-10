/**
 * Window control over typed RPC. Replaces POST /api/window/{hide,pin,resize}.
 * The bun handler delegates to the WindowController callback registered by
 * the chat feature on the ApiServer (see src/bun/features/chat/index.ts).
 */

import type { WindowOpenTarget } from "../index";

export type WindowRequests = {
	windowHide: {
		params: Record<string, never>;
		response: { ok: true };
	};
	windowPin: {
		params: { on: boolean };
		response: { ok: true };
	};
	windowResize: {
		params: { width: number; height: number };
		response: { ok: true };
	};
	// Open or focus a named window/view. Used by the command palette and
	// any cross-window navigation. The bun handler maps each target to
	// the appropriate action — show/focus an existing window, broadcast
	// a uiOpen* message, or no-op for unsupported targets — see
	// src/bun/core/rpc/handlers/window.ts.
	windowOpen: {
		params: { target: WindowOpenTarget };
		response: { ok: true };
	};
};
