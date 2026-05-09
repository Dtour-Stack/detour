import type {
	ElizaCloudModelsResponse,
	OpenRouterModelsResponse,
	ProviderId,
	ProviderInfo,
} from "../../../../shared/index";
import type {
	CloudAppsList,
	CloudContainersList,
	CloudContainerStatus,
	CloudCreditsBalance,
	CloudVideoGenerationParams,
	CloudVideoResult,
} from "../../../../shared/rpc/providers";
import { fetchOpenRouterModels } from "../../openrouter-models";
import { fetchElizaCloudModels } from "../../elizacloud-models";
import type { RpcDeps } from "../types";

// ProviderId → AccountCredentialProvider mapping. Anthropic and OpenAI
// each have an OAuth account store separate from the vault API key
// path; OpenRouter and ElizaCloud are vault-key-only.
const OAUTH_PROVIDER_FOR: Partial<Record<ProviderId, "anthropic-subscription" | "openai-codex">> = {
	anthropic: "anthropic-subscription",
	openai: "openai-codex",
};

const ELIZACLOUD_BASE = "https://www.elizacloud.ai/api/v1";
const ELIZACLOUD_BALANCE_URL = `${ELIZACLOUD_BASE}/credits/balance`;
const ELIZACLOUD_APPS_URL = `${ELIZACLOUD_BASE}/apps`;
const ELIZACLOUD_CONTAINERS_URL = `${ELIZACLOUD_BASE}/containers`;
const ELIZACLOUD_VIDEO_URL = `${ELIZACLOUD_BASE}/generate-video`;
const VALID_CONTAINER_STATUSES: CloudContainerStatus[] = [
	"pending",
	"provisioning",
	"running",
	"stopped",
	"disconnected",
	"error",
	"unknown",
];

function normalizeContainerStatus(value: unknown): CloudContainerStatus {
	if (typeof value !== "string") return "unknown";
	const lower = value.toLowerCase();
	return (VALID_CONTAINER_STATUSES as string[]).includes(lower)
		? (lower as CloudContainerStatus)
		: "unknown";
}

async function getElizaCloudApiKey(deps: RpcDeps): Promise<string | null> {
	const manager = await deps.vault.manager();
	if (!(await manager.has("ELIZAOS_CLOUD_API_KEY"))) return null;
	const key = await manager.get("ELIZAOS_CLOUD_API_KEY");
	return key && key.length > 0 ? key : null;
}

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
			const oauthCounts: Partial<Record<ProviderId, number>> = {};
			for (const [providerId, oauthProvider] of Object.entries(OAUTH_PROVIDER_FOR)) {
				try {
					oauthCounts[providerId as ProviderId] = deps.auth
						.listAccounts(oauthProvider)
						.length;
				} catch {
					oauthCounts[providerId as ProviderId] = 0;
				}
			}
			return list.map((p) => ({
				...p,
				active: runtimeProvider === p.id,
				oauthAccountCount: oauthCounts[p.id] ?? 0,
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
			// Two storage paths exist for any single provider (vault API
			// key + OAuth account records). Removing only one leaves
			// orphaned credentials that the runtime can still pick up,
			// which is exactly the "can't remove the token" UX bug.
			// Wipe BOTH so the user sees a clean slate.
			await deps.vault.removeProviderKey(params.id);
			const oauthProvider = OAUTH_PROVIDER_FOR[params.id];
			if (oauthProvider) {
				try {
					const accounts = deps.auth.listAccounts(oauthProvider);
					for (const acc of accounts) {
						try {
							deps.auth.deleteAccount(oauthProvider, acc.id);
						} catch (err) {
							console.warn(
								`[providers] failed to delete OAuth account ${oauthProvider}/${acc.id}:`,
								err instanceof Error ? err.message : err,
							);
						}
					}
				} catch (err) {
					console.warn(
						`[providers] OAuth account list failed for ${oauthProvider}:`,
						err instanceof Error ? err.message : err,
					);
				}
			}
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
			const apiKey = await getElizaCloudApiKey(deps);
			if (!apiKey) return { balance: 0, signedIn: false };
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

		cloudListApps: async (_params: Record<string, never>): Promise<CloudAppsList> => {
			const apiKey = await getElizaCloudApiKey(deps);
			if (!apiKey) return { apps: [], signedIn: false };
			try {
				const res = await fetch(ELIZACLOUD_APPS_URL, {
					headers: { Authorization: `Bearer ${apiKey}` },
				});
				if (res.status === 401 || res.status === 403) {
					return { apps: [], signedIn: false, error: "API key was rejected. Reconnect via Cloud sign-in." };
				}
				if (!res.ok) {
					const body = await res.text().catch(() => res.statusText);
					return { apps: [], signedIn: true, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
				}
				const data = (await res.json()) as { apps?: unknown };
				const apps = Array.isArray(data.apps)
					? data.apps.flatMap((entry): CloudAppsList["apps"] => {
						if (!entry || typeof entry !== "object") return [];
						const e = entry as Record<string, unknown>;
						const id = typeof e.id === "string" ? e.id : null;
						const name = typeof e.name === "string" ? e.name : null;
						if (!id || !name) return [];
						return [{
							id,
							name,
							description: typeof e.description === "string" ? e.description : null,
							app_url: typeof e.app_url === "string" ? e.app_url : null,
							website_url: typeof e.website_url === "string" ? e.website_url : null,
							contact_email: typeof e.contact_email === "string" ? e.contact_email : null,
							logo_url: typeof e.logo_url === "string" ? e.logo_url : null,
							created_at: typeof e.created_at === "string" ? e.created_at : undefined,
							updated_at: typeof e.updated_at === "string" ? e.updated_at : undefined,
						}];
					})
					: [];
				return { apps, signedIn: true };
			} catch (err) {
				return {
					apps: [],
					signedIn: true,
					error: err instanceof Error ? err.message : String(err),
				};
			}
		},

		cloudListContainers: async (
			_params: Record<string, never>,
		): Promise<CloudContainersList> => {
			const apiKey = await getElizaCloudApiKey(deps);
			if (!apiKey) return { containers: [], signedIn: false };
			try {
				const res = await fetch(ELIZACLOUD_CONTAINERS_URL, {
					headers: { Authorization: `Bearer ${apiKey}` },
				});
				if (res.status === 401 || res.status === 403) {
					return { containers: [], signedIn: false, error: "API key was rejected. Reconnect via Cloud sign-in." };
				}
				if (!res.ok) {
					const body = await res.text().catch(() => res.statusText);
					return { containers: [], signedIn: true, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
				}
				const json = (await res.json()) as { data?: unknown };
				const containers = Array.isArray(json.data)
					? json.data.flatMap((entry): CloudContainersList["containers"] => {
						if (!entry || typeof entry !== "object") return [];
						const e = entry as Record<string, unknown>;
						const id = typeof e.id === "string" ? e.id : null;
						if (!id) return [];
						return [{
							id,
							name: typeof e.name === "string" ? e.name : null,
							status: normalizeContainerStatus(e.status),
							image: typeof e.image === "string" ? e.image : null,
							host: typeof e.host === "string" ? e.host : null,
							endpoint_url: typeof e.endpoint_url === "string" ? e.endpoint_url : null,
							created_at: typeof e.created_at === "string" ? e.created_at : undefined,
							updated_at: typeof e.updated_at === "string" ? e.updated_at : undefined,
						}];
					})
					: [];
				return { containers, signedIn: true };
			} catch (err) {
				return {
					containers: [],
					signedIn: true,
					error: err instanceof Error ? err.message : String(err),
				};
			}
		},

		cloudGenerateVideo: async (
			params: CloudVideoGenerationParams,
		): Promise<CloudVideoResult> => {
			const apiKey = await getElizaCloudApiKey(deps);
			if (!apiKey) {
				return { ok: false, error: "Not signed in to ElizaOS Cloud — Cloud → ElizaOS Cloud → Connect." };
			}
			try {
				const res = await fetch(ELIZACLOUD_VIDEO_URL, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(params),
				});
				if (res.status === 402) {
					const body = (await res.json().catch(() => ({}))) as {
						required?: number;
					};
					return {
						ok: false,
						error: "Insufficient ElizaCloud credits. Top up via the Cloud tab.",
						...(typeof body.required === "number" ? { insufficientCredits: { required: body.required } } : {}),
					};
				}
				if (!res.ok) {
					const body = await res.text().catch(() => res.statusText);
					return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
				}
				const data = (await res.json()) as {
					id?: string;
					video?: { url?: string; width?: number; height?: number; file_size?: number; content_type?: string };
					cost?: { totalCost?: number };
				};
				if (!data.video?.url) {
					return { ok: false, error: "ElizaCloud returned no video URL" };
				}
				return {
					ok: true,
					id: typeof data.id === "string" ? data.id : "",
					video: {
						url: data.video.url,
						...(typeof data.video.width === "number" ? { width: data.video.width } : {}),
						...(typeof data.video.height === "number" ? { height: data.video.height } : {}),
						...(typeof data.video.file_size === "number" ? { fileSize: data.video.file_size } : {}),
						...(typeof data.video.content_type === "string" ? { contentType: data.video.content_type } : {}),
					},
					...(typeof data.cost?.totalCost === "number" ? { cost: { totalCost: data.cost.totalCost } } : {}),
				};
			} catch (err) {
				return {
					ok: false,
					error: err instanceof Error ? err.message : String(err),
				};
			}
		},
	};
}
