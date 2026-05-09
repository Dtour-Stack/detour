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
import { authRequests } from "./handlers/auth";
import { browserRequests } from "./handlers/browser";
import { channelsRequests } from "./handlers/channels";
import { chatRequests } from "./handlers/chat";
import { configRequests } from "./handlers/config";
import { cronRequests } from "./handlers/cron";
import { debugRequests } from "./handlers/debug";
import { externalRequests } from "./handlers/external";
import { gatewayRequests } from "./handlers/gateway";
import { inboxRequests } from "./handlers/inbox";
import { llamaRequests } from "./handlers/llama";
import { osRequests } from "./handlers/os";
import { ownerBindRequests } from "./handlers/owner-bind";
import { pensieveRequests } from "./handlers/pensieve";
import { portlessRequests } from "./handlers/portless";
import { providersRequests } from "./handlers/providers";
import { routingRequests } from "./handlers/routing";
import { vaultRequests } from "./handlers/vault";
import { viewMessages } from "./handlers/log";
import { windowRequests } from "./handlers/window";
import { agentProjectsRequests } from "./handlers/agent-projects";
import { githubChannelRequests } from "./handlers/github-channel";
import { tasksRequests } from "./handlers/tasks";
import type { RpcBroadcaster, RpcDeps } from "./types";

type SendFn = (name: string, payload: unknown) => void;

const openWindows = new Set<SendFn>();

/**
 * The global broadcaster instance — handed to every handler factory
 * via deps. Iterates registered window send fns. Safe to call from
 * service event listeners; no-op if no windows are open yet.
 */
export const broadcaster: RpcBroadcaster = {
	broadcast(name, payload) {
		for (const send of openWindows) {
			try {
				send(name, payload);
			} catch (err) {
				console.warn(`[rpc] broadcast(${name}) failed:`, err instanceof Error ? err.message : err);
			}
		}
	},
};

export function registerWindow(send: SendFn): () => void {
	openWindows.add(send);
	return () => openWindows.delete(send);
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
			...routingRequests(deps),
			...channelsRequests(deps),
			...portlessRequests(deps),
			...cronRequests(deps),
			...ownerBindRequests(deps),
			...inboxRequests(deps),
			...gatewayRequests(deps),
			...chatRequests(deps),
			...debugRequests(deps),
			...agentProjectsRequests(deps),
			...githubChannelRequests(deps),
			...tasksRequests(deps),
		},
		// View→bun fire-and-forget messages (the webview side of the
		// schema). logWebview routes console/error forwarding into
		// ActivityLogService.
		messages: {
			...viewMessages(deps),
		},
	};
}

export function buildRpcDeps(input: Omit<RpcDeps, "broadcaster">): RpcDeps {
	return { ...input, broadcaster };
}
