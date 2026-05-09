import type { BackendStatus } from "../../../../shared/index";
import type { RpcDeps } from "../types";

/**
 * Canonical handler factory pattern.
 *
 *   1. One file per feature group.
 *   2. Functions receive `deps` (RpcDeps) — no service singletons.
 *   3. Each function returns a typed bag of handlers; registry
 *      composes them.
 *   4. Server-push messages flow through `deps.broadcaster.broadcast(...)`
 *      OR via the WS→RPC bridge in registry.ts (which translates legacy
 *      `api.publish({kind: ...})` calls to typed RPC pushes — that's the
 *      transitional layer until HTTP/WS is fully removed).
 */

export function vaultRequests(deps: RpcDeps) {
	return {
		vaultListBackends: async (_params: Record<string, never>): Promise<BackendStatus[]> => {
			const manager = await deps.vault.manager();
			// detectBackends returns readonly; the RPC wire shape is a
			// fresh mutable array (JSON parse on the receiving side
			// would produce one anyway).
			return [...await manager.detectBackends()];
		},
	};
}
