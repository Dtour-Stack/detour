import type { PortlessRoute, PortlessSnapshot } from "../../../../shared/index";
import type { RpcDeps } from "../types";

/**
 * Portless — local-dev reverse proxy management. Mirrors the legacy
 * /api/portless/* HTTP routes shape-for-shape:
 *   - status      → GET    /api/portless/status
 *   - addRoute    → POST   /api/portless/routes
 *   - removeRoute → DELETE /api/portless/routes/<hostname>
 *   - prune       → POST   /api/portless/prune
 */
export function portlessRequests(deps: RpcDeps) {
	return {
		portlessStatus: async (_params: Record<string, never>): Promise<PortlessSnapshot> => {
			return deps.portless.snapshot();
		},
		portlessAddRoute: async (
			params: { hostname: string; port: number; force?: boolean },
		): Promise<{ ok: true; killedPid?: number; snapshot: PortlessSnapshot }> => {
			const { hostname, port, force } = params;
			if (!hostname || typeof port !== "number") {
				throw new Error("hostname and port required");
			}
			const result = deps.portless.addRoute(hostname, port, { force });
			const snapshot = deps.portless.snapshot();
			return result.killedPid !== undefined
				? { ok: true, killedPid: result.killedPid, snapshot }
				: { ok: true, snapshot };
		},
		portlessRemoveRoute: async (
			params: { hostname: string },
		): Promise<{ ok: true; snapshot: PortlessSnapshot }> => {
			if (!params.hostname) throw new Error("hostname required");
			deps.portless.removeRoute(params.hostname);
			return { ok: true, snapshot: deps.portless.snapshot() };
		},
		portlessPrune: async (
			_params: Record<string, never>,
		): Promise<{ ok: true; removed: PortlessRoute[]; snapshot: PortlessSnapshot }> => {
			const removed = deps.portless.pruneStale();
			return { ok: true, removed, snapshot: deps.portless.snapshot() };
		},
	};
}
