/**
 * Window controller registry — a tiny mutable singleton that lets the typed
 * RPC handler in handlers/window.ts invoke the chat feature's window
 * controller without coupling to the ApiServer's private state.
 *
 * The HTTP /api/window/* routes have been deleted; this is now the sole
 * dispatch path for hide/pin/resize. The chat feature still calls
 * setWindowControllerForRpc on boot to register its handler.
 */

import type { WindowCommand, WindowController } from "../api/server";

let controller: WindowController | null = null;

export function setWindowControllerForRpc(fn: WindowController | null): void {
	controller = fn;
}

export function runWindowCommand(cmd: WindowCommand): void {
	controller?.(cmd);
}
