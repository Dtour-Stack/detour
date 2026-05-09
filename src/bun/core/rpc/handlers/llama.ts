import type { LlamaServerStatusWire } from "../../../../shared/rpc/llama";
import type { RpcDeps } from "../types";

/**
 * Local llama-server status. Mirrors GET /api/llama/status — pure read of
 * the in-memory snapshot maintained by LlamaServerService.
 *
 * Note: `restart` and `download-progress` HTTP endpoints called out in the
 * migration plan don't actually exist in src/bun/core/api/server.ts today,
 * so they are intentionally absent here. `downloadProgress` is already
 * surfaced as a field on the status payload.
 */
export function llamaRequests(deps: RpcDeps) {
	return {
		llamaStatus: async (_params: Record<string, never>): Promise<LlamaServerStatusWire> => {
			return deps.llama.status();
		},
	};
}
