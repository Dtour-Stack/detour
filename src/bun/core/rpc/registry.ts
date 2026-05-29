/**
 * RPC registry — single source of truth for what handler bag every
 * webview gets. Composes per-feature handler factories
 * (src/bun/core/rpc/handlers/*) and exposes:
 *
 *   - buildRpcHandlers(deps): the `handlers` bag passed to
 *     BrowserView.defineRPC for every window
 *   - registerWindow / unregisterWindow: tracks open webviews so
 *     broadcast() can fan out to all of them
 *
 * This file is the canonical merge point. Every feature-migration agent
 * adds 1 spread of their `<group>Requests(deps)` into `buildRpcHandlers`.
 */

import { activityRequests } from "./handlers/activity";
import { agentMailRequests } from "./handlers/agentmail";
import { authRequests } from "./handlers/auth";
import { browserRequests } from "./handlers/browser";
import { channelsRequests } from "./handlers/channels";
import { chatRequests, chatMessages } from "./handlers/chat";
import { configRequests } from "./handlers/config";
import { debugRequests } from "./handlers/debug";
import { externalRequests } from "./handlers/external";
import { gatewayRequests } from "./handlers/gateway";
import { inboxRequests } from "./handlers/inbox";
import { llamaRequests } from "./handlers/llama";
import { osRequests } from "./handlers/os";
import { ownerBindRequests } from "./handlers/owner-bind";
import { pensieveRequests } from "./handlers/pensieve";
import { portlessRequests } from "./handlers/portless";
import { providersRequests, installProviderQuotaBroadcast } from "./handlers/providers";
import { vaultRequests } from "./handlers/vault";
import { viewMessages } from "./handlers/log";
import { windowRequests } from "./handlers/window";
import { agentProjectsRequests } from "./handlers/agent-projects";
import { githubChannelRequests } from "./handlers/github-channel";
import { tasksRequests } from "./handlers/tasks";
import { petsRequests, petsMessages } from "./handlers/pets";
import { phantomRequests } from "./handlers/phantom";
import { mediaRequests } from "./handlers/media";
import { goalsRequests } from "./handlers/goals";
import { dreamsRequests } from "./handlers/dreams";
import { promptSlotsRequests } from "./handlers/prompt-slots";
import { skillsRequests } from "./handlers/skills";
import { superteamEarnRequests } from "./handlers/superteam-earn";
import { walletStatsRequests } from "./handlers/wallet-stats";
import { capsuleRequests, capsuleMessages } from "./handlers/capsule";
import { trayPopoverRequests, trayPopoverMessages } from "./handlers/tray-popover";
import { calendarRequests } from "./handlers/calendar";
import { printingPressRequests } from "./handlers/printing-press";
import { recapRequests } from "./handlers/recap";
import type { RpcBroadcaster, RpcDeps } from "./types";

type SendFn = (name: string, payload: unknown) => void;

const openWindows = new Set<SendFn>();

/**
 * The global broadcaster instance — handed to every handler factory
 * via deps. Iterates registered window send fns. Safe to call from
 * service event listeners; no-op if no windows are open yet.
 *
 * A failing send (window torn down between broadcasts and the unregister
 * callback firing) auto-evicts the entry so we don't spam every
 * subsequent broadcast with the same `[rpc] broadcast(...) failed` line.
 */
export const broadcaster: RpcBroadcaster = {
	broadcast(name, payload) {
		// Snapshot the set so an eviction inside the loop can't perturb
		// JS's "modify during iteration" semantics (skip / repeat).
		const targets = [...openWindows];
		for (const send of targets) {
			try {
				send(name, payload);
			} catch (err) {
				openWindows.delete(send);
				console.warn(
					`[rpc] broadcast(${name}) failed; dropped dead window:`,
					err instanceof Error ? err.message : err,
				);
			}
		}
	},
};

export function registerWindow(send: SendFn): () => void {
	openWindows.add(send);
	return () => {
		openWindows.delete(send);
	};
}

/**
 * Build the typed handler bag for a window. Always returns a freshly
 * composed object so adding handlers via mutation isn't a footgun.
 */
export function buildRpcHandlers(deps: RpcDeps) {
	return {
		requests: {
			...vaultRequests(deps),
			...providersRequests(deps),
			...authRequests(deps),
			...configRequests(deps),
			...pensieveRequests(deps),
			...activityRequests(deps),
			...browserRequests(deps),
			...llamaRequests(deps),
			...windowRequests(deps),
			...externalRequests(deps),
			...osRequests(deps),
			...channelsRequests(deps),
			...portlessRequests(deps),
			...ownerBindRequests(deps),
			...inboxRequests(deps),
			...gatewayRequests(deps),
			...chatRequests(deps),
			...debugRequests(deps),
			...agentProjectsRequests(deps),
			...githubChannelRequests(deps),
			...tasksRequests(deps),
			...petsRequests(deps),
			...mediaRequests(deps),
			...phantomRequests(deps),
			...goalsRequests(deps),
			...dreamsRequests(deps),
			...promptSlotsRequests(deps),
			...skillsRequests(deps),
			...walletStatsRequests(deps),
			...agentMailRequests(deps),
			...superteamEarnRequests(deps),
			...calendarRequests(deps),
			...printingPressRequests(deps),
			...recapRequests(deps),
			...capsuleRequests(),
			...trayPopoverRequests(),
		},
		// View→bun fire-and-forget messages (the webview side of the
		// schema). logWebview routes console/error forwarding into
		// ActivityLogService.
		messages: {
			...viewMessages(deps),
			...chatMessages(deps),
			...petsMessages(deps),
			...capsuleMessages(),
			...trayPopoverMessages(),
		},
	};
}

export function buildRpcDeps(input: Omit<RpcDeps, "broadcaster">): RpcDeps {
	const deps: RpcDeps = { ...input, broadcaster };
	// Subscribe the broadcaster to ProviderQuotaService once per process.
	// onChange returns an unsubscribe but the registry lives for the
	// lifetime of the app — wiring is fire-and-forget.
	installProviderQuotaBroadcast(deps);
	return deps;
}
