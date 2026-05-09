/**
 * Channel-gateway RPC handlers. Mirror /api/gateway/* in
 * src/bun/core/api/server.ts.
 *
 *   - gatewayFeed       → ChannelGatewayService.list({ channel?, direction?, q?, limit? })
 *   - gatewayIdentities → ChannelGatewayService.identityCandidates()
 *
 * The bun-side service also exposes `allIdentities()` (the full map)
 * but no current view exercises it, so the RPC sticks to
 * merge-candidates — the only view the UI uses.
 */

import type {
	GatewayMessage,
	IdentityCandidate,
	ListOptions as GatewayListOptions,
} from "../../channels/gateway";
import type { RpcDeps } from "../types";
import type { GatewayFeedOptions } from "../../../../shared/rpc/gateway";

export function gatewayRequests(deps: RpcDeps) {
	return {
		gatewayFeed: async (
			params: GatewayFeedOptions,
		): Promise<{ messages: GatewayMessage[]; total: number }> => {
			const opts: GatewayListOptions = {};
			if (params.channel) opts.channel = params.channel;
			if (params.direction) opts.direction = params.direction;
			if (params.q) opts.q = params.q;
			if (params.limit !== undefined) opts.limit = params.limit;
			return deps.gateway.list(opts);
		},
		gatewayIdentities: async (
			_params: Record<string, never>,
		): Promise<{ identities: IdentityCandidate[] }> => {
			return { identities: deps.gateway.identityCandidates() };
		},
	};
}
