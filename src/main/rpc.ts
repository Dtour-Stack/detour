/**
 * View-side typed RPC singleton — canonical IPC per
 * .claude/rules/electrobun.md.
 *
 * Use this instead of WebClient HTTP fetch for migrated methods. Each
 * `rpc.request.*` round-trips through electrobun's native postMessage
 * bridge (no HTTP/CORS/network in the loop) to the bun main process,
 * which dispatches to the handler defined alongside the chat window's
 * BrowserWindow construction.
 *
 * As we migrate HTTP endpoints to RPC, methods land in src/shared/rpc.ts
 * and the corresponding `client.foo()` call sites in views switch to
 * `rpc.request.foo()`.
 */

import Electrobun, { Electroview } from "electrobun/view";
import type { DetourRPC } from "../shared/rpc";

const rpcDef = Electroview.defineRPC<DetourRPC>({
	maxRequestTime: 30_000,
	handlers: {
		// View side has no requests/messages from bun yet — those come over
		// `messages` (fire-and-forget pushes from bun, listened to via the
		// `messages` handler bag below).
		requests: {},
		messages: {
			tokenDelta: () => { /* per-window listeners attach via electroview events */ },
			messageComplete: () => { /* same — see below */ },
			providerChanged: () => { /* listener attached lazily */ },
		},
	},
});

const electroview = new Electrobun.Electroview({ rpc: rpcDef });

export const rpc = rpcDef;
export const view = electroview;
