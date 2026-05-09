/**
 * Window controller registry — a tiny mutable singleton that lets the typed
 * RPC handler in handlers/window.ts invoke the chat feature's window
 * controller without coupling to the ApiServer's private state.
 *
 * The chat feature wires this up alongside the legacy
 * `apiServer.setWindowController(...)` so both transports (HTTP /api/window/*
 * and typed RPC windowHide/Pin/Resize) drive the same controller. When the
 * HTTP routes are deleted in Phase 2, the chat feature can stop calling
 * setWindowController.
 */

import type { WindowCommand, WindowController } from "../api/server";

let controller: WindowController | null = null;

export function setWindowControllerForRpc(fn: WindowController | null): void {
	controller = fn;
}

export function runWindowCommand(cmd: WindowCommand): void {
	controller?.(cmd);
}
