import type {
	ElizaCloudModelsResponse,
	OpenRouterModelsResponse,
	ProviderId,
	ProviderInfo,
} from "../../../../shared/index";
import type { CloudCreditsBalance } from "../../../../shared/rpc/providers";
import { fetchOpenRouterModels } from "../../openrouter-models";
import { fetchElizaCloudModels } from "../../elizacloud-models";
import type { RpcDeps } from "../types";

const ELIZACLOUD_BALANCE_URL = "https://www.elizacloud.ai/api/v1/credits/balance";

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
			// Don't await runtime build here — the build can take many
			// seconds (eliza plugin init + PGlite migrations + channel
			// boot), and blocking providersList means the Providers tab
			// hangs on every refresh while the runtime catches up. Read
			// current state synchronously; if the runtime hasn't built
			// yet, kick off a background build whose `providerChanged`
			// broadcast on success will trigger another refresh from
			// the view.
			if (!deps.runtime.peek()) {
				void deps.runtime
					.getOrBuild()
					.then(() => {
						deps.broadcaster.broadcast("providerChanged", {
							activeProvider: deps.runtime.getCurrentProvider(),
						});
					})
					.catch(() => {});
			}
			const runtimeProvider = deps.runtime.getCurrentProvider();
			return list.map((p) => ({
				...p,
				active: runtimeProvider === p.id,
			}));
		},

		providersSetKey: async (params: { id: ProviderId; key: string }): Promise<{ ok: true }> => {
			await deps.vault.setProviderKey(params.id, params.key);
			const current = deps.runtime.getCurrentProvider();
			// Background rebuild — broadcast the new active state once it
			// finishes. Same rationale as providersList: the rebuild can
			// take many seconds, and we don't want the save click to hang.
			if (!current || current === params.id) {
				void deps.runtime
					.rebuild()
					.then(() => {
						deps.broadcaster.broadcast("providerChanged", {
							activeProvider: deps.runtime.getCurrentProvider(),
						});
					})
					.catch((err) => console.error("[runtime] rebuild after setProviderKey failed:", err));
			}
			deps.broadcaster.broadcast("providerChanged", {
				activeProvider: await deps.vault.getActiveProvider(),
			});
			return { ok: true };
		},

		providersRemoveKey: async (params: { id: ProviderId }): Promise<{ ok: true }> => {
			await deps.vault.removeProviderKey(params.id);
			if (deps.runtime.getCurrentProvider() === params.id) {
				void deps.runtime
					.rebuild()
					.then(() => {
						deps.broadcaster.broadcast("providerChanged", {
							activeProvider: deps.runtime.getCurrentProvider(),
						});
					})
					.catch((err) => console.error("[runtime] rebuild after removeProviderKey failed:", err));
			}
			deps.broadcaster.broadcast("providerChanged", {
				activeProvider: await deps.vault.getActiveProvider(),
			});
			return { ok: true };
		},

		providersSetActive: async (params: { id: ProviderId }): Promise<{ ok: true }> => {
			await deps.vault.setActiveProvider(params.id);
			void deps.runtime
				.rebuild()
				.then(() => {
					deps.broadcaster.broadcast("providerChanged", {
						activeProvider: deps.runtime.getCurrentProvider(),
					});
				})
				.catch((err) => console.error("[runtime] rebuild after setActiveProvider failed:", err));
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

		providersElizaCloudModels: async (
			_params: Record<string, never>,
		): Promise<ElizaCloudModelsResponse> => {
			const manager = await deps.vault.manager();
			const apiKey = (await manager.has("ELIZAOS_CLOUD_API_KEY"))
				? await manager.get("ELIZAOS_CLOUD_API_KEY")
				: undefined;
			return fetchElizaCloudModels({ apiKey });
		},

		cloudCreditsBalance: async (
			_params: Record<string, never>,
		): Promise<CloudCreditsBalance> => {
			const manager = await deps.vault.manager();
			if (!(await manager.has("ELIZAOS_CLOUD_API_KEY"))) {
				return { balance: 0, signedIn: false };
			}
			const apiKey = await manager.get("ELIZAOS_CLOUD_API_KEY");
			try {
				const res = await fetch(ELIZACLOUD_BALANCE_URL, {
					headers: { Authorization: `Bearer ${apiKey}` },
				});
				if (res.status === 401 || res.status === 403) {
					return { balance: 0, signedIn: false, error: "API key was rejected (401/403). Reconnect via Cloud sign-in." };
				}
				if (!res.ok) {
					const body = await res.text().catch(() => res.statusText);
					return { balance: 0, signedIn: true, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
				}
				const data = (await res.json()) as { balance?: number };
				return {
					balance: typeof data.balance === "number" ? data.balance : 0,
					signedIn: true,
				};
			} catch (err) {
				return {
					balance: 0,
					signedIn: true,
					error: err instanceof Error ? err.message : String(err),
				};
			}
		},
	};
}
