import type { DetourRPC } from "../../shared/rpc";

type UiPreferencesChangedPayload = DetourRPC["bun"]["messages"]["uiPreferencesChanged"];
type UiPreferencesChangedListener = (payload: UiPreferencesChangedPayload) => void;

type TrayPrefsChangedPayload = DetourRPC["bun"]["messages"]["trayPrefsChanged"];
type TrayPrefsChangedListener = (payload: TrayPrefsChangedPayload) => void;

const subscribers = new Set<UiPreferencesChangedListener>();
const trayPrefsSubs = new Set<TrayPrefsChangedListener>();

/**
 * Subscribe to uiPreferencesChanged push events. Replaces the WS
 * `ui:preferences-changed` listener pattern. React components call this
 * in useEffect; the returned function unsubscribes.
 */
export function onUiPreferencesChanged(listener: UiPreferencesChangedListener): () => void {
	subscribers.add(listener);
	return () => subscribers.delete(listener);
}

export function onTrayPrefsChanged(listener: TrayPrefsChangedListener): () => void {
	trayPrefsSubs.add(listener);
	return () => trayPrefsSubs.delete(listener);
}

export function configMessages() {
	return {
		uiPreferencesChanged: (payload: UiPreferencesChangedPayload) => {
			for (const fn of subscribers) {
				try { fn(payload); } catch (err) {
					console.warn("[rpc/config] listener threw:", err);
				}
			}
		},
		trayPrefsChanged: (payload: TrayPrefsChangedPayload) => {
			for (const fn of trayPrefsSubs) {
				try { fn(payload); } catch (err) {
					console.warn("[rpc/config] tray listener threw:", err);
				}
			}
		},
	};
}
