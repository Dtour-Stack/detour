/**
 * Channel-gateway RPC (unified inbound/outbound feed across all channels).
 * Wire shapes match the legacy HTTP routes 1:1:
 *
 *   GET /api/gateway/feed?channel&direction&q&limit → gatewayFeed
 *     → { messages, total }
 *   GET /api/gateway/identities                     → gatewayIdentities
 *     → { identities }
 *
 * The feed filter is narrowed to channel / direction / q / limit (the
 * bun-side service also supports roomId / entityId / since, but no
 * current call site uses them). Identities returns merge-candidates
 * only — the service's `allIdentities()` map view isn't exposed because
 * no current view consumes it.
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
