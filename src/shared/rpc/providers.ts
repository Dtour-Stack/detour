import type {
	ElizaCloudModelsResponse,
	OpenRouterModelsResponse,
	ProviderId,
	ProviderInfo,
} from "../index";

export type CloudCreditsBalance = {
	balance: number;
	error?: string;
	signedIn: boolean;
};

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
	// ElizaCloud model catalog — same fetch-and-bucket pattern as
	// OpenRouter, hits https://www.elizacloud.ai/api/v1/models with the
	// stored API key. Returns a flat list grouped by inferred upstream
	// provider for the Cloud tab's model pickers.
	providersElizaCloudModels: {
		params: Record<string, never>;
		response: ElizaCloudModelsResponse;
	};
	// ElizaCloud credit balance — surfaces the user's remaining cloud
	// credits in the Cloud tab. Wraps GET /api/v1/credits/balance with
	// the stored API key. Soft-fails on 401/403/network errors so the
	// tab never crashes — `signedIn` and `error` carry the diagnostic.
	cloudCreditsBalance: {
		params: Record<string, never>;
		response: CloudCreditsBalance;
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
