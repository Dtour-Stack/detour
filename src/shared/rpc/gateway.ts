/**
 * Channel-gateway RPC (unified inbound/outbound feed across all channels).
 * Wire shapes match the legacy HTTP routes 1:1:
 *
 *   GET /api/gateway/feed?channel&direction&q&limit → gatewayFeed
 *     → { messages, total }
 *   GET /api/gateway/identities                     → gatewayIdentities
 *     → { identities }
 *
 * The feed filter is narrowed to channel / direction / q / limit to match
 * the existing WebClient surface (other HTTP query params like roomId /
 * entityId / since aren't used by any current call site). The `all=1`
 * variant of identities isn't exposed via WebClient either, so the RPC
 * stays on the default `identityCandidates()` (merge-candidate) view.
 */

import type {
	GatewayChannel,
	GatewayDirection,
	GatewayMessage,
	IdentityCandidate,
} from "../../bun/core/channels/gateway";

export type GatewayFeedOptions = {
	channel?: GatewayChannel;
	direction?: GatewayDirection;
	q?: string;
	limit?: number;
};

export type GatewayRequests = {
	gatewayFeed: {
		params: GatewayFeedOptions;
		response: { messages: GatewayMessage[]; total: number };
	};
	gatewayIdentities: {
		params: Record<string, never>;
		response: { identities: IdentityCandidate[] };
	};
};
