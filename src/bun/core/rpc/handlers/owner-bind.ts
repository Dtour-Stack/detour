/**
 * Owner-bind RPC handlers. Mirror /api/owner-bind/* in
 * src/bun/core/api/server.ts.
 *
 *   - ownerBindGenerateCode → OwnerBindService.generateCode(connector)
 *   - ownerBindStatus       → OwnerBindService.getOwner(connector)
 *   - ownerBindUnbind       → OwnerBindService.unbind(connector)
 *
 * The wire shape mirrors the HTTP path exactly: generate returns
 * `{ ok, code, expiresAt, connector }` (the connector echo lets the UI
 * confirm the code matches the connector it's about to display).
 */

import type { OwnerConnector } from "../../owner-bind";
import type { RpcDeps } from "../types";
import type { OwnerBindOwner } from "../../../../shared/rpc/owner-bind";

export function ownerBindRequests(deps: RpcDeps) {
	return {
		ownerBindGenerateCode: async (
			params: { connector: OwnerConnector },
		): Promise<{ ok: true; code: string; expiresAt: number; connector: OwnerConnector }> => {
			const issued = deps.ownerBind.generateCode(params.connector);
			return { ok: true, ...issued, connector: params.connector };
		},
		ownerBindStatus: async (
			params: { connector: OwnerConnector },
		): Promise<{ connector: OwnerConnector; bound: boolean; owner: OwnerBindOwner | null }> => {
			const owner = await deps.ownerBind.getOwner(params.connector);
			return { connector: params.connector, bound: !!owner, owner };
		},
		ownerBindUnbind: async (
			params: { connector: OwnerConnector },
		): Promise<{ ok: true }> => {
			await deps.ownerBind.unbind(params.connector);
			return { ok: true };
		},
	};
}
