import type { OpenRouterModelBuckets, OpenRouterModelCapability, OpenRouterModelInfo, OpenRouterModelsResponse } from "../../shared/index";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models?output_modalities=all";
const OPENROUTER_EMBEDDING_MODELS_URL = "https://openrouter.ai/api/v1/embeddings/models";

type FetchModelsOptions = {
	apiKey?: string;
};

type RawOpenRouterModel = Record<string, unknown>;

export async function fetchOpenRouterModels(options: FetchModelsOptions = {}): Promise<OpenRouterModelsResponse> {
	const headers: HeadersInit = options.apiKey
		? { Authorization: `Bearer ${options.apiKey}` }
		: {};
	const base = await fetchModelList(OPENROUTER_MODELS_URL, headers);
	let embeddings: OpenRouterModelInfo[] = [];
	try {
		embeddings = await fetchModelList(OPENROUTER_EMBEDDING_MODELS_URL, headers);
	} catch {
		embeddings = [];
	}
	const byId = new Map<string, OpenRouterModelInfo>();
	for (const model of [...base, ...embeddings]) {
		byId.set(model.id, mergeModel(byId.get(model.id), model));
	}
	const models = [...byId.values()].sort(compareModels);
	const buckets = emptyBuckets();
	for (const model of models) {
		for (const capability of model.capabilities) {
			buckets[capability].push(model);
		}
	}
	return { fetchedAt: Date.now(), models, buckets };
}

async function fetchModelList(url: string, headers: HeadersInit): Promise<OpenRouterModelInfo[]> {
	const res = await fetch(url, { headers });
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`OpenRouter models HTTP ${res.status}: ${body.slice(0, 240)}`);
	}
	const json = await res.json() as { data?: unknown };
	if (!Array.isArray(json.data)) throw new Error("OpenRouter models response missing data array");
	return json.data.flatMap((item): OpenRouterModelInfo[] => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return [];
		const model = normalizeModel(item as RawOpenRouterModel);
		return model ? [model] : [];
	});
}

function normalizeModel(raw: RawOpenRouterModel): OpenRouterModelInfo | null {
	const id = stringValue(raw.id);
	if (!id) return null;
	const name = stringValue(raw.name) ?? id;
	const architecture = objectValue(raw.architecture);
	const pricing = objectValue(raw.pricing);
	const inputModalities = stringArray(architecture?.input_modalities);
	const outputModalities = stringArray(architecture?.output_modalities);
	const supportedParameters = stringArray(raw.supported_parameters);
	const normalizedPricing = {
		...(stringValue(pricing?.prompt) ? { prompt: stringValue(pricing?.prompt) } : {}),
		...(stringValue(pricing?.completion) ? { completion: stringValue(pricing?.completion) } : {}),
		...(stringValue(pricing?.request) ? { request: stringValue(pricing?.request) } : {}),
		...(stringValue(pricing?.image) ? { image: stringValue(pricing?.image) } : {}),
		...(stringValue(pricing?.web_search) ? { webSearch: stringValue(pricing?.web_search) } : {}),
		...(stringValue(pricing?.internal_reasoning) ? { internalReasoning: stringValue(pricing?.internal_reasoning) } : {}),
		...(stringValue(pricing?.input_cache_read) ? { inputCacheRead: stringValue(pricing?.input_cache_read) } : {}),
		...(stringValue(pricing?.input_cache_write) ? { inputCacheWrite: stringValue(pricing?.input_cache_write) } : {}),
	};
	const isFree = freeModel(id, name, normalizedPricing);
	const capabilities = capabilitiesFor({
		id,
		name,
		inputModalities,
		outputModalities,
		isFree,
	});
	return {
		id,
		name,
		...(stringValue(raw.description) ? { description: stringValue(raw.description) } : {}),
		...(numberValue(raw.context_length) ? { contextLength: numberValue(raw.context_length) } : {}),
		inputModalities,
		outputModalities,
		supportedParameters,
		pricing: normalizedPricing,
		isFree,
		capabilities,
	};
}

function capabilitiesFor(model: {
	id: string;
	name: string;
	inputModalities: string[];
	outputModalities: string[];
	isFree: boolean;
}): OpenRouterModelCapability[] {
	const input = new Set(model.inputModalities.map((value) => value.toLowerCase()));
	const output = new Set(model.outputModalities.map((value) => value.toLowerCase()));
	const needle = `${model.id} ${model.name}`.toLowerCase();
	const capabilities = new Set<OpenRouterModelCapability>();
	if (output.has("text") || output.size === 0) capabilities.add("text");
	if (input.has("image")) capabilities.add("vision");
	if (output.has("image")) capabilities.add("image");
	if (output.has("embeddings") || output.has("embedding") || needle.includes("embedding")) capabilities.add("embedding");
	if (model.isFree) capabilities.add("free");
	return [...capabilities];
}

function freeModel(id: string, name: string, pricing: OpenRouterModelInfo["pricing"]): boolean {
	if (id.endsWith(":free") || name.toLowerCase().includes("(free)")) return true;
	const values = Object.values(pricing);
	return values.length > 0 && values.every((value) => numericZero(value));
}

function numericZero(value: string | undefined): boolean {
	if (value === undefined) return false;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed === 0;
}

function mergeModel(prev: OpenRouterModelInfo | undefined, next: OpenRouterModelInfo): OpenRouterModelInfo {
	if (!prev) return next;
	const capabilities = [...new Set([...prev.capabilities, ...next.capabilities])];
	const inputModalities = [...new Set([...prev.inputModalities, ...next.inputModalities])];
	const outputModalities = [...new Set([...prev.outputModalities, ...next.outputModalities])];
	const supportedParameters = [...new Set([...prev.supportedParameters, ...next.supportedParameters])];
	return {
		...prev,
		...next,
		inputModalities,
		outputModalities,
		supportedParameters,
		capabilities,
		pricing: { ...prev.pricing, ...next.pricing },
		isFree: prev.isFree || next.isFree,
	};
}

function compareModels(a: OpenRouterModelInfo, b: OpenRouterModelInfo): number {
	if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
	return a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id);
}

function emptyBuckets(): OpenRouterModelBuckets {
	return {
		text: [],
		free: [],
		embedding: [],
		vision: [],
		image: [],
	};
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
		: [];
}
