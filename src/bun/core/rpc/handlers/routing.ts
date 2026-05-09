import { readRoutingConfig } from "@elizaos/vault";
import type { RoutingConfigWire } from "../../../../shared/rpc/routing";
import type { RpcDeps } from "../types";

/**
 * Routing profile config — vault-backed read. Replaces GET /api/routing.
 *
 * The PUT /api/routing route is intentionally not migrated here because it
 * has no webview call site (only legacy HTTP). When/if a webview UI for
 * editing routing rules lands, add `routingSet` to the schema.
 */
export function routingRequests(deps: RpcDeps) {
	return {
		routingGet: async (_params: Record<string, never>): Promise<RoutingConfigWire> => {
			const v = await deps.vault.vault();
			return await readRoutingConfig(v);
		},
	};
}
