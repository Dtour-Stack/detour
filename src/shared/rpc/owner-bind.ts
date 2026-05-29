/**
 * Owner-bind RPC (eliza /eliza_pair flow). Wire shapes match the legacy
 * HTTP routes 1:1:
 *
 *   POST   /api/owner-bind/code        → ownerBindGenerateCode
 *     body { connector } → { ok, code, expiresAt, connector }
 *   GET    /api/owner-bind/<connector> → ownerBindStatus
 *     → { connector, bound, owner }
 *   DELETE /api/owner-bind/<connector> → ownerBindUnbind
 *     → { ok }
 *
 * Connector enum mirrors the bun-side service: telegram | discord |
 * wechat | matrix. Current call sites only invoke telegram | discord
 * but the schema exposes the full set so future surfaces don't need a
 * second migration.
 */

// Single source of truth for the connector enum. The bun-side OwnerBindService
// imports it back from here (shared is a leaf — it must not depend on bun).
export type OwnerConnector = "telegram" | "discord" | "wechat" | "matrix";

export type OwnerBindOwner = {
	externalId: string;
	displayHandle: string;
};

export type OwnerBindRequests = {
	ownerBindGenerateCode: {
		params: { connector: OwnerConnector };
		response: {
			ok: true;
			code: string;
			expiresAt: number;
			connector: OwnerConnector;
		};
	};
	ownerBindStatus: {
		params: { connector: OwnerConnector };
		response: {
			connector: OwnerConnector;
			bound: boolean;
			owner: OwnerBindOwner | null;
		};
	};
	ownerBindUnbind: {
		params: { connector: OwnerConnector };
		response: { ok: true };
	};
};
