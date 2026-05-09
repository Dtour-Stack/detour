/**
 * Live ElizaOS Cloud model catalog. Fetches the OpenAI-style /models
 * endpoint and groups by inferred upstream provider.
 *
 * Wire shape mirrors @elizaos/plugin-elizacloud's CloudModelRegistryService —
 * same `/models` URL, same `data: [{ id, object, created, owned_by }, ...]`
 * envelope. We bucket by upstream provider (openai/anthropic/google/...)
 * via the same prefix table the plugin uses, so the picker UI in
 * Detour's ModelsTab can group identically to what the agent sees at
 * runtime.
 */

import type {
	ElizaCloudModelInfo,
	ElizaCloudModelsResponse,
} from "../../shared/index";

const ELIZACLOUD_MODELS_URL = "https://www.elizacloud.ai/api/v1/models";

type FetchOptions = {
	apiKey?: string;
};

interface RawModelEntry {
	id: string;
	object?: string;
	created?: number;
	owned_by?: string;
}

interface RawModelsResponse {
	object?: string;
	data?: RawModelEntry[];
}

// Mirrors plugin-elizacloud/services/cloud-model-registry.ts so a model
// id classified as "openai" here lands in the same bucket the agent
// uses for runtime routing.
const PROVIDER_PREFIXES: ReadonlyArray<[string, string]> = [
	["gpt-", "openai"],
	["o1", "openai"],
	["o3", "openai"],
	["o4", "openai"],
	["dall-e", "openai"],
	["whisper", "openai"],
	["tts", "openai"],
	["text-embedding", "openai"],
	["claude-", "anthropic"],
	["gemini-", "google"],
	["llama", "meta"],
	["deepseek", "deepseek"],
	["grok", "xai"],
	["kimi", "moonshot"],
];

function inferProvider(modelId: string, ownedBy?: string): string {
	if (modelId.includes("/")) return modelId.split("/")[0]!;
	const lower = modelId.toLowerCase();
	for (const [prefix, provider] of PROVIDER_PREFIXES) {
		if (lower.startsWith(prefix)) return provider;
	}
	if (ownedBy && ownedBy.length > 0 && ownedBy !== "system") return ownedBy;
	return "unknown";
}

export async function fetchElizaCloudModels(
	options: FetchOptions = {},
): Promise<ElizaCloudModelsResponse> {
	const headers: HeadersInit = options.apiKey
		? { Authorization: `Bearer ${options.apiKey}` }
		: {};
	let raw: RawModelsResponse;
	let error: string | undefined;
	try {
		const res = await fetch(ELIZACLOUD_MODELS_URL, { headers });
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new Error(`ElizaCloud /models HTTP ${res.status}: ${body.slice(0, 240)}`);
		}
		raw = (await res.json()) as RawModelsResponse;
	} catch (err) {
		return {
			fetchedAt: Date.now(),
			models: [],
			byProvider: {},
			error: err instanceof Error ? err.message : String(err),
		};
	}
	const entries = Array.isArray(raw.data) ? raw.data : [];
	const models: ElizaCloudModelInfo[] = entries
		.flatMap((entry): ElizaCloudModelInfo[] => {
			if (!entry || typeof entry.id !== "string" || entry.id.length === 0) return [];
			return [{
				id: entry.id,
				ownedBy: typeof entry.owned_by === "string" ? entry.owned_by : "system",
				provider: inferProvider(entry.id, entry.owned_by),
				createdAt: typeof entry.created === "number" ? entry.created : 0,
			}];
		})
		.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
	const byProvider: Record<string, ElizaCloudModelInfo[]> = {};
	for (const model of models) {
		(byProvider[model.provider] ??= []).push(model);
	}
	return {
		fetchedAt: Date.now(),
		models,
		byProvider,
		...(error ? { error } : {}),
	};
}
