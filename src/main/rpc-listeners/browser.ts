import type { DetourRPC } from "../../shared/rpc";

type UiOpenBrowserPayload = DetourRPC["bun"]["messages"]["uiOpenBrowser"];
type UiOpenBrowserListener = (payload: UiOpenBrowserPayload) => void;
type BrowserCommandPayload = DetourRPC["bun"]["messages"]["browserCommand"];
type BrowserCommandListener = (payload: BrowserCommandPayload) => void;

const uiOpenBrowserSubscribers = new Set<UiOpenBrowserListener>();
const browserCommandSubscribers = new Set<BrowserCommandListener>();

/**
 * Subscribe to uiOpenBrowser push events. Replaces the WS
 * `ui:open-browser` listener pattern. Currently no view-side caller
 * needs this (the bun-side kernel handles tray/menu reveal), but the
 * subscriber slot exists so future webviews can react to the same
 * "reveal browser" signal without re-introducing WS plumbing.
 */
export function onUiOpenBrowser(listener: UiOpenBrowserListener): () => void {
	uiOpenBrowserSubscribers.add(listener);
	return () => uiOpenBrowserSubscribers.delete(listener);
}

/**
 * Subscribe to browserCommand push events. Replaces the WS
 * `browser:command` listener pattern. The BrowserView component uses
 * this to pick up newly-enqueued commands (open, inspect, script,
 * fill-login) live without polling.
 */
export function onBrowserCommand(listener: BrowserCommandListener): () => void {
	browserCommandSubscribers.add(listener);
	return () => browserCommandSubscribers.delete(listener);
}

export function browserMessages() {
	return {
		uiOpenBrowser: (payload: UiOpenBrowserPayload) => {
			for (const fn of uiOpenBrowserSubscribers) {
				try { fn(payload); } catch (err) {
					console.warn("[rpc/browser] uiOpenBrowser listener threw:", err);
				}
			}
		},
		browserCommand: (payload: BrowserCommandPayload) => {
			for (const fn of browserCommandSubscribers) {
				try { fn(payload); } catch (err) {
					console.warn("[rpc/browser] browserCommand listener threw:", err);
				}
			}
		},
	};
}
