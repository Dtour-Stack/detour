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
import type { ProvidersRequests, ProvidersMessages } from "./providers";
import type { AuthRequests, AuthMessages } from "./auth";
import type { ConfigRequests, ConfigMessages } from "./config";
import type { PensieveRequests } from "./pensieve";
import type { ActivityRequests } from "./activity";
import type { BrowserRequests, BrowserMessages } from "./browser";
import type { LlamaRequests } from "./llama";
import type { WindowRequests } from "./window";
import type { ExternalRequests } from "./external";
import type { OsRequests } from "./os";
import type { RoutingRequests } from "./routing";
import type { ChannelsRequests } from "./channels";
import type { PortlessRequests } from "./portless";
import type { CronRequests } from "./cron";
import type { OwnerBindRequests } from "./owner-bind";
import type { InboxRequests } from "./inbox";
import type { GatewayRequests } from "./gateway";

export type DetourBunRequests =
	& VaultRequests
	& ProvidersRequests
	& AuthRequests
	& ConfigRequests
	& PensieveRequests
	& ActivityRequests
	& BrowserRequests
	& LlamaRequests
	& WindowRequests
	& ExternalRequests
	& OsRequests
	& RoutingRequests
	& ChannelsRequests
	& PortlessRequests
	& CronRequests
	& OwnerBindRequests
	& InboxRequests
	& GatewayRequests;

export type DetourBunMessages =
	& VaultMessages
	& ProvidersMessages
	& AuthMessages
	& ConfigMessages
	& BrowserMessages;

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
