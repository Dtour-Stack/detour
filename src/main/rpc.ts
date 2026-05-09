/**
 * View-side typed RPC singleton — canonical IPC per
 * .claude/rules/electrobun.md.
 *
 * Use this instead of WebClient HTTP fetch for migrated methods. Each
 * `rpc.request.*` round-trips through electrobun's native postMessage
 * bridge (no HTTP/CORS/network in the loop) to the bun main process,
 * which dispatches to handlers composed in
 * src/bun/core/rpc/registry.ts.
 *
 * As HTTP endpoints migrate, methods land in src/shared/rpc/<group>.ts
 * and the corresponding `client.foo()` call sites switch to
 * `rpc.request.foo()`. Server-push messages (replacing WS) listen via
 * the per-feature subscribers exported from
 * src/main/rpc-listeners/<group>.ts.
 */

import Electrobun, { Electroview } from "electrobun/view";
import type { DetourRPC } from "../shared/rpc";
import { buildViewListeners } from "./rpc-listeners";

const rpcDef = Electroview.defineRPC<DetourRPC>({
	maxRequestTime: 30_000,
	handlers: {
		// View side has no incoming requests — bun never asks the view to
		// answer anything in this app. All view→bun traffic is `request`,
		// all bun→view traffic is `messages`.
		requests: {},
		messages: buildViewListeners(),
	},
});

const electroview = new Electrobun.Electroview({ rpc: rpcDef });

export const rpc = rpcDef;
export const view = electroview;
