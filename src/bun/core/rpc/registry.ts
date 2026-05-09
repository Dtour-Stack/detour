/**
 * RPC registry — single source of truth for what handler bag every
 * webview gets. Composes per-feature handler factories
 * (src/bun/core/rpc/handlers/*) and exposes:
 *
 *   - buildRpcHandlers(deps): the `handlers` bag passed to
 *     BrowserView.defineRPC for every window
 *   - registerWindow / unregisterWindow: tracks open webviews so
 *     broadcast() can fan out to all of them
 *   - bridgeWsToRpc(api): translates legacy `api.publish({kind: ...})`
 *     ws pushes to typed RPC `broadcast(...)` calls. Lives until HTTP/WS
 *     is fully removed in Phase 2.
 *
 * This file is the canonical merge point. Every feature-migration agent
 * adds:
 *   - 1 case to `WS_TO_RPC` if their group has WS messages
 *   - 1 spread of their `<group>Requests(deps)` into `buildRpcHandlers`
 */

import type { ApiServer } from "../api/server";
import type { WsServerMessage } from "../../../shared/index";
import { vaultRequests } from "./handlers/vault";
import { providersRequests } from "./handlers/providers";
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
		},
		messages: {},
	};
}

/**
 * Translation table: legacy WsServerMessage kinds → RPC message names +
 * payload shapes from the typed schema. Each entry MUST match a
 * `messages` key in src/shared/rpc/<group>.ts.
 *
 * As feature groups migrate, agents:
 *   1. Add the message to their `src/shared/rpc/<group>.ts` schema
 *   2. Add a translation entry here
 *   3. Add the listener in src/main/rpc-listeners/<group>.ts
 *   4. Eventually remove both the WS publish site AND this entry once
 *      HTTP/WS is gone
 */
function translateWsToRpc(msg: WsServerMessage): { name: string; payload: unknown } | null {
	switch (msg.kind) {
		case "provider:changed":
			return { name: "providerChanged", payload: { activeProvider: msg.activeProvider } };
		case "backend:changed":
			return { name: "backendChanged", payload: { backendId: msg.backendId } };
		default:
			return null;
	}
}

/**
 * Wire `api.publish()` → `broadcaster.broadcast()`. Calling this once at
 * startup gives every existing legacy WS publish call site a "free"
 * RPC counterpart, so views can listen via RPC and migration becomes
 * incremental rather than all-or-nothing.
 *
 * Returns an unsubscriber for cleanup.
 */
export function bridgeWsToRpc(api: ApiServer): () => void {
	return api.listen((msg) => {
		const translated = translateWsToRpc(msg);
		if (translated) broadcaster.broadcast(translated.name, translated.payload);
	});
}

export function buildRpcDeps(input: Omit<RpcDeps, "broadcaster">): RpcDeps {
	return { ...input, broadcaster };
}
