import type {
	ElizaCloudModelsResponse,
	OpenRouterModelsResponse,
	ProviderId,
	ProviderInfo,
	ProviderQuotaState,
} from "../index";

export type { ProviderQuotaState, ProviderQuotaCap } from "../index";

export type CloudCreditsBalance = {
	balance: number;
	error?: string;
	signedIn: boolean;
};

// ── Cloud apps + containers (cloud/apps/api/v1/apps + /containers) ──
// Mirrors elizacloud.ai's user-facing endpoints. Detour surfaces them
// read-only with provision buttons that pop the dashboard for create
// flows (which require domain ownership / billing flows that aren't
// worth re-implementing here).

export type CloudApp = {
	readonly id: string;
	readonly name: string;
	readonly description: string | null;
	readonly app_url: string | null;
	readonly website_url?: string | null;
	readonly contact_email?: string | null;
	readonly logo_url?: string | null;
	readonly created_at?: string;
	readonly updated_at?: string;
};

export type CloudAppsList = {
	apps: CloudApp[];
	signedIn: boolean;
	error?: string;
};

export type CloudContainerStatus =
	| "pending"
	| "provisioning"
	| "running"
	| "stopped"
	| "disconnected"
	| "error"
	| "unknown";

export type CloudContainer = {
	readonly id: string;
	readonly name?: string | null;
	readonly status: CloudContainerStatus;
	readonly image?: string | null;
	readonly host?: string | null;
	readonly endpoint_url?: string | null;
	readonly created_at?: string;
	readonly updated_at?: string;
};

export type CloudContainersList = {
	containers: CloudContainer[];
	signedIn: boolean;
	error?: string;
};

// ── Video generation (cloud/apps/api/v1/generate-video) ───────────
// Wraps Fal-AI (veo3 default) via ElizaCloud's billing layer. Returns
// a finished video URL — fal's flow is synchronous from our POV so
// no polling needed on the Detour side.

export type CloudVideoGenerationParams = {
	prompt: string;
	model?: string;
	referenceUrl?: string;
	durationSeconds?: number;
	resolution?: string;
	audio?: boolean;
	voiceControl?: boolean;
};

export type CloudVideoResult =
	| {
			ok: true;
			id: string;
			video: {
				url: string;
				path?: string;
				galleryId?: string;
				width?: number;
				height?: number;
				fileSize?: number;
				contentType?: string;
			};
			cost?: { totalCost: number };
	  }
	| {
			ok: false;
			error: string;
			insufficientCredits?: { required: number };
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
	// Snapshot of all currently-active paid-plan quota caps. The chat UI
	// fetches this on mount so a banner can be drawn even before the next
	// `providerQuotaChanged` event fires, and the Settings tab uses it for
	// the "capped until X" badge on each provider.
	providersGetQuotaState: {
		params: Record<string, never>;
		response: ProviderQuotaState;
	};
	// User-configured fallback chain — providers the runtime walks AFTER
	// the active one when the active credentials are quota-capped. Order
	// matters; first item is tried first when a cap hits. Empty list =
	// no automatic rotation (fb54849b's default).
	providersGetFallbackOrder: {
		params: Record<string, never>;
		response: { order: ProviderId[] };
	};
	providersSetFallbackOrder: {
		params: { order: ProviderId[] };
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
	// ElizaCloud apps registry — hosted client-app records the user
	// owns (each one gets an API key + optional GitHub repo). Wraps
	// GET /api/v1/apps. Read-only on the Detour side; create/update
	// happens in the dashboard.
	cloudListApps: {
		params: Record<string, never>;
		response: CloudAppsList;
	};
	// ElizaCloud containers — Hetzner-Docker-backed agent runtimes.
	// Wraps GET /api/v1/containers. Provisioning requires the cloud
	// control plane and isn't surfaced here; Detour links to the
	// dashboard for that.
	cloudListContainers: {
		params: Record<string, never>;
		response: CloudContainersList;
	};
	// Video generation — POST /api/v1/generate-video. Synchronous from
	// the Detour-side POV (Fal returns the finished video URL when the
	// request completes). Used by the `/video` chat slash command.
	cloudGenerateVideo: {
		params: CloudVideoGenerationParams;
		response: CloudVideoResult;
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
	// Broadcast whenever ProviderQuotaService.mark/clear/expire fires. The
	// chat banner subscribes to this so a Codex Pro cap (or any future
	// usage_limit_reached) becomes visible the moment the upstream throws,
	// without waiting for the next user turn.
	providerQuotaChanged: ProviderQuotaState;
};
