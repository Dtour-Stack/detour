import type { DetourRPC } from "../../shared/rpc";

type DeltaPayload = DetourRPC["bun"]["messages"]["chatDelta"];
type CompletePayload = DetourRPC["bun"]["messages"]["chatComplete"];
type ErrorPayload = DetourRPC["bun"]["messages"]["chatError"];
type SettingsPayload = DetourRPC["bun"]["messages"]["uiOpenSettings"];

const deltaSubs = new Set<(p: DeltaPayload) => void>();
const completeSubs = new Set<(p: CompletePayload) => void>();
const errorSubs = new Set<(p: ErrorPayload) => void>();
const settingsSubs = new Set<(p: SettingsPayload) => void>();

export function onChatDelta(fn: (p: DeltaPayload) => void): () => void {
	deltaSubs.add(fn);
	return () => deltaSubs.delete(fn);
}
export function onChatComplete(fn: (p: CompletePayload) => void): () => void {
	completeSubs.add(fn);
	return () => completeSubs.delete(fn);
}
export function onChatError(fn: (p: ErrorPayload) => void): () => void {
	errorSubs.add(fn);
	return () => errorSubs.delete(fn);
}
export function onUiOpenSettings(fn: (p: SettingsPayload) => void): () => void {
	settingsSubs.add(fn);
	return () => settingsSubs.delete(fn);
}

function fanout<P>(subs: Set<(p: P) => void>, payload: P, label: string): void {
	for (const fn of subs) {
		try { fn(payload); } catch (err) {
			console.warn(`[rpc/${label}] listener threw:`, err);
		}
	}
}

export function chatMessages() {
	return {
		chatDelta: (payload: DeltaPayload) => fanout(deltaSubs, payload, "chatDelta"),
		chatComplete: (payload: CompletePayload) => fanout(completeSubs, payload, "chatComplete"),
		chatError: (payload: ErrorPayload) => fanout(errorSubs, payload, "chatError"),
		uiOpenSettings: (payload: SettingsPayload) => fanout(settingsSubs, payload, "uiOpenSettings"),
	};
}
