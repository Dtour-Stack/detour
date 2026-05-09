import type {
	OpenRouterModelsResponse,
	ProviderId,
	ProviderInfo,
} from "../index";

export type ProvidersRequests = {
	providersList: {
		params: Record<string, never>;
		response: ProviderInfo[];
	};
	providersSetKey: {
		params: { id: ProviderId; key: string };
		response: { ok: true };
	};
	providersRemoveKey: {
		params: { id: ProviderId };
		response: { ok: true };
	};
	providersSetActive: {
		params: { id: ProviderId };
		response: { ok: true };
	};
	providersOpenRouterModels: {
		params: Record<string, never>;
		response: OpenRouterModelsResponse;
	};
};

export type ProvidersMessages = {
	// Replaces ws `provider:changed`. Broadcast whenever the active provider
	// rotates (key set, key removed, explicit setActive call). Bridged from
	// the legacy WS publish via src/bun/core/rpc/registry.ts until the WS
	// server is removed in Phase 2. The handlers in
	// src/bun/core/rpc/handlers/providers.ts ALSO call
	// `deps.broadcaster.broadcast("providerChanged", ...)` directly — the
	// double-publish is harmless and matches the canonical pattern in
	// docs/rpc-migration.md.
	providerChanged: { activeProvider: ProviderId | null };
};
