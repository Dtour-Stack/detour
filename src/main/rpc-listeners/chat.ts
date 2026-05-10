import type { DetourRPC } from "../../shared/rpc";

type DeltaPayload = DetourRPC["bun"]["messages"]["chatDelta"];
type CompletePayload = DetourRPC["bun"]["messages"]["chatComplete"];
type ErrorPayload = DetourRPC["bun"]["messages"]["chatError"];
type SettingsPayload = DetourRPC["bun"]["messages"]["uiOpenSettings"];
type CommandRunPayload = DetourRPC["bun"]["messages"]["chatCommandRun"];
type EmptyPayload = Record<string, never>;

const deltaSubs = new Set<(p: DeltaPayload) => void>();
const completeSubs = new Set<(p: CompletePayload) => void>();
const errorSubs = new Set<(p: ErrorPayload) => void>();
const settingsSubs = new Set<(p: SettingsPayload) => void>();
const commandRunSubs = new Set<(p: CommandRunPayload) => void>();
const openChatSubs = new Set<(p: EmptyPayload) => void>();
const openPaletteSubs = new Set<(p: EmptyPayload) => void>();
const openPensieveSubs = new Set<(p: EmptyPayload) => void>();
const openActivitySubs = new Set<(p: EmptyPayload) => void>();
const openChannelsSubs = new Set<(p: EmptyPayload) => void>();
const openBrowserSubs = new Set<(p: EmptyPayload) => void>();
const openAgentsSubs = new Set<(p: EmptyPayload) => void>();
const openPetSubs = new Set<(p: EmptyPayload) => void>();

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
export function onChatCommandRun(fn: (p: CommandRunPayload) => void): () => void {
	commandRunSubs.add(fn);
	return () => commandRunSubs.delete(fn);
}
export function onUiOpenChat(fn: (p: EmptyPayload) => void): () => void {
	openChatSubs.add(fn);
	return () => openChatSubs.delete(fn);
}
export function onUiOpenCommandPalette(fn: (p: EmptyPayload) => void): () => void {
	openPaletteSubs.add(fn);
	return () => openPaletteSubs.delete(fn);
}
export function onUiOpenPensieve(fn: (p: EmptyPayload) => void): () => void {
	openPensieveSubs.add(fn);
	return () => openPensieveSubs.delete(fn);
}
export function onUiOpenActivity(fn: (p: EmptyPayload) => void): () => void {
	openActivitySubs.add(fn);
	return () => openActivitySubs.delete(fn);
}
export function onUiOpenChannels(fn: (p: EmptyPayload) => void): () => void {
	openChannelsSubs.add(fn);
	return () => openChannelsSubs.delete(fn);
}
export function onUiOpenBrowser(fn: (p: EmptyPayload) => void): () => void {
	openBrowserSubs.add(fn);
	return () => openBrowserSubs.delete(fn);
}
export function onUiOpenAgents(fn: (p: EmptyPayload) => void): () => void {
	openAgentsSubs.add(fn);
	return () => openAgentsSubs.delete(fn);
}
export function onUiOpenPet(fn: (p: EmptyPayload) => void): () => void {
	openPetSubs.add(fn);
	return () => openPetSubs.delete(fn);
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
		chatCommandRun: (payload: CommandRunPayload) => fanout(commandRunSubs, payload, "chatCommandRun"),
		uiOpenChat: (payload: EmptyPayload) => fanout(openChatSubs, payload, "uiOpenChat"),
		uiOpenCommandPalette: (payload: EmptyPayload) => fanout(openPaletteSubs, payload, "uiOpenCommandPalette"),
		uiOpenPensieve: (payload: EmptyPayload) => fanout(openPensieveSubs, payload, "uiOpenPensieve"),
		uiOpenActivity: (payload: EmptyPayload) => fanout(openActivitySubs, payload, "uiOpenActivity"),
		uiOpenChannels: (payload: EmptyPayload) => fanout(openChannelsSubs, payload, "uiOpenChannels"),
		uiOpenBrowser: (payload: EmptyPayload) => fanout(openBrowserSubs, payload, "uiOpenBrowser"),
		uiOpenAgents: (payload: EmptyPayload) => fanout(openAgentsSubs, payload, "uiOpenAgents"),
		uiOpenPet: (payload: EmptyPayload) => fanout(openPetSubs, payload, "uiOpenPet"),
	};
}
