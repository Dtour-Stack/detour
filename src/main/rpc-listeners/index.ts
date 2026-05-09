/**
 * View-side message listener composition. Each per-feature module
 * exports a listener factory; this index file composes them into the
 * `messages` bag passed to Electroview.defineRPC.
 *
 * Migration: when a feature group needs to receive an RPC message
 * (replacing a legacy WS push), they create
 * `src/main/rpc-listeners/<group>.ts` exporting a `<group>Messages()`
 * function that returns an object of message-name → handler. Then
 * spread it into the composed bag below.
 */

import type { DetourRPC } from "../../shared/rpc";
import { authMessages } from "./auth";
import { browserMessages } from "./browser";
import { chatMessages } from "./chat";
import { configMessages } from "./config";
import { providersMessages } from "./providers";
import { vaultMessages } from "./vault";

type ViewMessageBag = {
	[K in keyof DetourRPC["bun"]["messages"]]?: (payload: DetourRPC["bun"]["messages"][K]) => void;
};

/**
 * The composed listener bag. Each feature's factory returns its slice
 * of handlers — they all dispatch to module-local subscribers via
 * `subscribe<group>()` exports, so React components can attach without
 * coupling to the schema.
 */
export function buildViewListeners(): ViewMessageBag {
	return {
		...providersMessages(),
		...authMessages(),
		...vaultMessages(),
		...configMessages(),
		...browserMessages(),
		...chatMessages(),
	};
}
