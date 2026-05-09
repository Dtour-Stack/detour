/**
 * Shared RPC schema composition — assembled from per-feature schema
 * fragments under `src/shared/rpc/`. Per .claude/rules/electrobun.md,
 * the schema lives in shared/ so both bun and view contexts import from
 * a single source of truth.
 *
 * Adding a feature group:
 *   1. Create `src/shared/rpc/<group>.ts` exporting `<Group>Requests`
 *      and/or `<Group>Messages` types (omit either if empty).
 *   2. Add the import + intersection below. Empty groups are NOT
 *      intersected — `Record<string, never>` collapses the type to an
 *      index signature that breaks per-key typechecking.
 *   3. Implement the handler factory at
 *      `src/bun/core/rpc/handlers/<group>.ts` and wire it into the
 *      registry at `src/bun/core/rpc/registry.ts`.
 *
 * Migration tracker: docs/rpc-migration.md
 */

import type { RPCSchema } from "electrobun/bun";
import type { VaultRequests, VaultMessages } from "./vault";
import type { ProvidersMessages } from "./providers";

export type DetourBunRequests =
	& VaultRequests;

export type DetourBunMessages =
	& VaultMessages
	& ProvidersMessages;

export type DetourRPC = {
	bun: RPCSchema<{
		requests: DetourBunRequests;
		messages: DetourBunMessages;
	}>;
	webview: RPCSchema<{
		requests: Record<never, never>;
		messages: Record<never, never>;
	}>;
};
