import type { ProviderId } from "../index";

export type ProvidersMessages = {
	// Replaces ws `provider:changed`. Broadcast whenever the active provider
	// rotates (key set, key removed, explicit setActive call). Bridged from
	// the legacy WS publish via src/bun/core/rpc/registry.ts until the WS
	// server is removed in Phase 2.
	providerChanged: { activeProvider: ProviderId | null };
};
