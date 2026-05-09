/**
 * Shared RPC schema between bun (main process) and webviews.
 *
 * Per .claude/rules/electrobun.md:
 *   "Define schemas once in `src/shared/`, import in both bun and view contexts"
 *
 * This file is the canonical contract for typed RPC. The HTTP/WebSocket
 * layer (src/bun/core/api/server.ts ↔ src/main/api/client.ts) is being
 * progressively migrated here. Methods land in groups; each migrated
 * group can drop its HTTP handlers + fetch sites once verified.
 *
 * Migration tracker: docs/rpc-migration.md
 */

import type { RPCSchema } from "electrobun/bun";
import type { BackendStatus } from "./index";

/**
 * Main-window RPC schema — shared by every webview that talks to the bun
 * main process. The chat window currently mounts every settings drawer
 * tab, so all settings ops are reachable from the main window's RPC
 * instance. Per-feature RPC schemas can split out later if/when separate
 * windows have disjoint needs.
 */
export type DetourRPC = {
	bun: RPCSchema<{
		requests: {
			// ── chat window controls (already-typed; pre-RPC-migration) ────
			chatSendMessage: {
				params: { text: string; convId: string };
				response: { ok: true };
			};
			chatHideWindow: {
				params: Record<string, never>;
				response: { ok: true };
			};
			chatOpenSettings: {
				params: Record<string, never>;
				response: { ok: true };
			};
			chatIsReady: {
				params: Record<string, never>;
				response: { ready: boolean; activeProvider: string | null };
			};

			// ── vault (first migrated feature) ─────────────────────────────
			vaultListBackends: {
				params: Record<string, never>;
				response: BackendStatus[];
			};
		};
		messages: {
			// Server-push events from bun → webview.
			tokenDelta: { convId: string; delta: string };
			messageComplete: { convId: string };
			providerChanged: { activeProvider: string | null };
		};
	}>;
	webview: RPCSchema<{
		requests: Record<string, never>;
		messages: Record<string, never>;
	}>;
};
