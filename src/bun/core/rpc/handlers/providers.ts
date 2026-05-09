import type {
	OpenRouterModelsResponse,
	ProviderId,
	ProviderInfo,
} from "../../../../shared/index";
import { fetchOpenRouterModels } from "../../openrouter-models";
import type { RpcDeps } from "../types";

/**
 * Providers RPC handlers — replaces the HTTP routes:
 *   GET    /api/providers
 *   GET    /api/providers/openrouter/models
 *   PUT    /api/providers/<id>/key
 *   DELETE /api/providers/<id>/key
 *   PUT    /api/providers/active
 *
 * Each mutating handler broadcasts `providerChanged` directly via
 * `deps.broadcaster.broadcast(...)`. The legacy `provider:changed` WS
 * publish in src/bun/core/api/server.ts is also still bridged via
 * registry.ts, so the double-publish is harmless until WS is removed in
 * Phase 2 (per docs/rpc-migration.md "Adding a server-push message").
 */
export function providersRequests(deps: RpcDeps) {
	return {
		providersList: async (_params: Record<string, never>): Promise<ProviderInfo[]> => {
			const list = await deps.vault.listProviders();
			// Mirror server.ts:983-991 — ensure the runtime has built once so
			// `getCurrentProvider()` reflects the active state, then enrich
			// each entry with `active`.
			await deps.runtime.getOrBuild().catch(() => {});
			const runtimeProvider = deps.runtime.getCurrentProvider();
			return list.map((p) => ({
				...p,
				active: runtimeProvider === p.id,
			}));
		},

		providersSetKey: async (params: { id: ProviderId; key: string }): Promise<{ ok: true }> => {
			await deps.vault.setProviderKey(params.id, params.key);
			const current = deps.runtime.getCurrentProvider();
			if (!current || current === params.id) await deps.runtime.rebuild();
			deps.broadcaster.broadcast("providerChanged", {
				activeProvider: await deps.vault.getActiveProvider(),
			});
			return { ok: true };
		},

		providersRemoveKey: async (params: { id: ProviderId }): Promise<{ ok: true }> => {
			await deps.vault.removeProviderKey(params.id);
			if (deps.runtime.getCurrentProvider() === params.id) {
				await deps.runtime.rebuild();
			}
			deps.broadcaster.broadcast("providerChanged", {
				activeProvider: await deps.vault.getActiveProvider(),
			});
			return { ok: true };
		},

		providersSetActive: async (params: { id: ProviderId }): Promise<{ ok: true }> => {
			await deps.vault.setActiveProvider(params.id);
			await deps.runtime.rebuild();
			deps.broadcaster.broadcast("providerChanged", {
				activeProvider: params.id,
			});
			return { ok: true };
		},

		providersOpenRouterModels: async (
			_params: Record<string, never>,
		): Promise<OpenRouterModelsResponse> => {
			const manager = await deps.vault.manager();
			const apiKey = (await manager.has("OPENROUTER_API_KEY"))
				? await manager.get("OPENROUTER_API_KEY")
				: undefined;
			return fetchOpenRouterModels({ apiKey });
		},
	};
}
