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
 * Connector enum mirrors the HTTP server: telegram | discord | wechat |
 * matrix. The current WebClient only narrows to telegram | discord but the
 * server accepts the full set, so the RPC schema does too.
 */

import type { OwnerConnector } from "../../bun/core/owner-bind";

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
