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

// Single source of truth for the gateway wire shapes. The bun-side gateway
// service imports these back from here (shared is a leaf — it must not depend
// on bun).
export type GatewayDirection = "in" | "out" | "deleted" | "interaction";
export type GatewayChannel = "discord" | "telegram" | "imessage" | "chat" | "agentmail" | "twitter" | "unknown";

export interface GatewayMessage {
	readonly id: string;
	readonly time: number;
	readonly direction: GatewayDirection;
	readonly channel: GatewayChannel;
	readonly source: string;
	readonly roomId: string;
	readonly entityId: string;
	readonly externalHandle?: string;
	readonly text: string;
	readonly meta?: Record<string, unknown>;
}

export interface IdentityCandidate {
	readonly key: string;
	readonly channel: GatewayChannel;
	readonly externalHandle: string;
	readonly entityIds: string[];
	readonly firstSeen: number;
	readonly lastSeen: number;
	readonly messageCount: number;
}

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
