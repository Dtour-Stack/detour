import {
	ContentType,
	logger,
	ModelType,
	type Action,
	type ActionResult,
	type GenerateTextParams,
	type Handler,
	type HandlerCallback,
	type IAgentRuntime,
	type ImageDescriptionParams,
	type ImageGenerationParams,
	type ImageGenerationResult,
	type ObjectGenerationParams,
	type Plugin,
	type TextEmbeddingParams,
} from "@elizaos/core";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";
const DEFAULT_TEXT_MODEL = "openrouter/free";
const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small";
const DEFAULT_IMAGE_MODEL = "google/gemini-2.5-flash-image";
const REQUEST_TIMEOUT = 90_000;

type ChatRole = "system" | "user" | "assistant";
type TextPart = { type: "text"; text: string };
type ImagePart = { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };
type ChatMessage = {
	role: ChatRole;
	content: string | Array<TextPart | ImagePart>;
};

type OpenRouterImageGenerationResult = ImageGenerationResult & {
	revisedPrompt?: string;
};

type ChatExtra = {
	response_format?: { type: "json_object" };
	modalities?: string[];
	image_config?: Record<string, string>;
};

function setting(runtime: IAgentRuntime, key: string, fallback?: string): string | undefined {
	const value = runtime.getSetting(key);
	if (typeof value === "string" && value.length > 0) return value;
	const env = process.env[key];
	if (typeof env === "string" && env.length > 0) return env;
	return fallback;
}

function apiKey(runtime: IAgentRuntime): string {
	const key = setting(runtime, "OPENROUTER_API_KEY");
	if (!key) throw new Error("OPENROUTER_API_KEY is not set. Add an OpenRouter API key in Settings.");
	return key;
}

function pickModel(runtime: IAgentRuntime, key: string, fallback = DEFAULT_TEXT_MODEL): string {
	return setting(runtime, key, fallback) ?? fallback;
}

function headers(runtime: IAgentRuntime): HeadersInit {
	const out: Record<string, string> = {
		Authorization: `Bearer ${apiKey(runtime)}`,
		"Content-Type": "application/json",
	};
	const referer = setting(runtime, "OPENROUTER_SITE_URL");
	const title = setting(runtime, "OPENROUTER_APP_NAME", "Detour");
	if (referer) out["HTTP-Referer"] = referer;
	if (title) out["X-OpenRouter-Title"] = title;
	return out;
}

function numberParam(source: Record<string, unknown>, keys: readonly string[]): number | undefined {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

function textFromGenerateParams(params: GenerateTextParams): ChatMessage[] {
	const messages: ChatMessage[] = [];
	const rawMessages = (params as unknown as { messages?: Array<{ role?: unknown; content?: unknown }> }).messages;
	if (Array.isArray(rawMessages)) {
		for (const raw of rawMessages) {
			const role = raw.role === "assistant" || raw.role === "system" ? raw.role : "user";
			if (typeof raw.content === "string" && raw.content.length > 0) {
				messages.push({ role, content: raw.content });
			}
		}
	}
	const system = (params as unknown as { system?: unknown }).system;
	if (typeof system === "string" && system.length > 0 && !messages.some((m) => m.role === "system")) {
		messages.unshift({ role: "system", content: system });
	}
	if (typeof params.prompt === "string" && params.prompt.length > 0) {
		messages.push({ role: "user", content: params.prompt });
	}
	if (messages.length === 0) messages.push({ role: "user", content: "" });
	return messages;
}

async function postJson(runtime: IAgentRuntime, url: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT);
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: headers(runtime),
			body: JSON.stringify(body),
			signal: ctl.signal,
		});
		if (!res.ok) {
			const errorText = await res.text().catch(() => "");
			throw new Error(`OpenRouter HTTP ${res.status}: ${errorText.slice(0, 500)}`);
		}
		const data = await res.json();
		if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("OpenRouter returned a non-object response");
		return data as Record<string, unknown>;
	} finally {
		clearTimeout(timer);
	}
}

async function completeText(
	runtime: IAgentRuntime,
	model: string,
	params: GenerateTextParams,
	extra: ChatExtra = {},
): Promise<string> {
	const body: Record<string, unknown> = {
		model,
		messages: textFromGenerateParams(params),
		stream: false,
		...extra,
	};
	const paramBag = params as unknown as Record<string, unknown>;
	const maxTokens = numberParam(paramBag, ["maxTokens", "max_tokens", "maxOutputTokens"]);
	const temperature = numberParam(paramBag, ["temperature"]);
	if (maxTokens) body.max_tokens = maxTokens;
	if (temperature !== undefined) body.temperature = temperature;
	const response = await postJson(runtime, CHAT_URL, body);
	return extractText(response);
}

function extractText(response: Record<string, unknown>): string {
	const choices = Array.isArray(response.choices) ? response.choices : [];
	for (const choice of choices) {
		if (!choice || typeof choice !== "object" || Array.isArray(choice)) continue;
		const choiceObject = choice as Record<string, unknown>;
		if (typeof choiceObject.text === "string") return choiceObject.text;
		const message = objectValue(choiceObject.message);
		if (!message) continue;
		const content = message.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			const parts = content.flatMap((part): string[] => {
				if (!part || typeof part !== "object" || Array.isArray(part)) return [];
				const object = part as Record<string, unknown>;
				return typeof object.text === "string" ? [object.text] : [];
			});
			if (parts.length > 0) return parts.join("");
		}
	}
	throw new Error("OpenRouter chat response missing choices[0].message.content");
}

function extractImages(response: Record<string, unknown>): Array<{ url: string; revisedPrompt?: string }> {
	const out: Array<{ url: string; revisedPrompt?: string }> = [];
	const choices = Array.isArray(response.choices) ? response.choices : [];
	for (const choice of choices) {
		if (!choice || typeof choice !== "object" || Array.isArray(choice)) continue;
		const message = objectValue((choice as Record<string, unknown>).message);
		if (!message) continue;
		const images = Array.isArray(message.images) ? message.images : [];
		for (const image of images) {
			const imageObject = objectValue(image);
			const imageUrl = objectValue(imageObject?.image_url) ?? objectValue(imageObject?.imageUrl);
			const url = typeof imageUrl?.url === "string" ? imageUrl.url : undefined;
			if (!url) continue;
			const item: { url: string; revisedPrompt?: string } = { url };
			if (typeof imageObject?.revised_prompt === "string") item.revisedPrompt = imageObject.revised_prompt;
			out.push(item);
		}
	}
	return out;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function extractEmbedding(response: Record<string, unknown>): number[] {
	const data = Array.isArray(response.data) ? response.data : [];
	const first = objectValue(data[0]);
	const embedding = first?.embedding;
	if (!Array.isArray(embedding)) throw new Error("OpenRouter embedding response missing data[0].embedding");
	const values = embedding.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
	if (values.length !== embedding.length) throw new Error("OpenRouter embedding response contained non-numeric values");
	return values;
}

function embeddingText(params: TextEmbeddingParams | string | null | undefined): string {
	if (typeof params === "string") return params;
	if (!params) return "";
	const text = (params as { text?: unknown }).text;
	return typeof text === "string" ? text : "";
}

function imageDescriptionInput(params: ImageDescriptionParams | string): { url: string; prompt: string } {
	if (typeof params === "string") {
		return {
			url: params,
			prompt: "Describe this image. Respond as JSON: {\"title\": string, \"description\": string}",
		};
	}
	return {
		url: params.imageUrl,
		prompt: params.prompt ?? "Describe this image. Respond as JSON: {\"title\": string, \"description\": string}",
	};
}

function imageDescriptionResult(text: string): { title: string; description: string } {
	const fenced = text.match(/```(?:json)?\s*([\s\S]+?)```/);
	const raw = fenced?.[1] ?? text;
	try {
		const parsed = JSON.parse(raw) as { title?: unknown; description?: unknown };
		return {
			title: typeof parsed.title === "string" && parsed.title.length > 0 ? parsed.title : "Image",
			description: typeof parsed.description === "string" && parsed.description.length > 0 ? parsed.description : text,
		};
	} catch {
		return { title: "Image", description: text };
	}
}

function normalizeAspectRatio(size: string | undefined): string | undefined {
	if (!size) return undefined;
	const trimmed = size.trim();
	if (/^\d+:\d+$/.test(trimmed)) return trimmed;
	const match = trimmed.match(/^(\d{3,4})x(\d{3,4})$/);
	if (!match) return undefined;
	const width = Number(match[1]);
	const height = Number(match[2]);
	if (!Number.isFinite(width) || !Number.isFinite(height) || height <= 0) return undefined;
	const gcd = greatestCommonDivisor(width, height);
	return `${width / gcd}:${height / gcd}`;
}

function greatestCommonDivisor(a: number, b: number): number {
	let x = Math.abs(Math.round(a));
	let y = Math.abs(Math.round(b));
	while (y !== 0) {
		const t = y;
		y = x % y;
		x = t;
	}
	return x || 1;
}

function imageModalities(model: string): string[] {
	const lower = model.toLowerCase();
	return lower.includes("flux") || lower.includes("sourceful") ? ["image"] : ["image", "text"];
}

function imageExtension(mimeSubtype: string): string {
	const normalized = mimeSubtype.toLowerCase();
	if (normalized === "jpeg") return "jpg";
	const safe = normalized.replace(/[^a-z0-9]/g, "");
	return safe.length > 0 ? safe : "png";
}

function materializeGeneratedImage(url: string): string {
	const match = url.match(/^data:image\/([a-z0-9.+-]+);base64,(.+)$/i);
	if (!match) return url;
	const payload = match[2];
	if (!payload) throw new Error("Image generation returned an empty image payload.");
	const dir = mkdtempSync(join(tmpdir(), "detour-openrouter-image-"));
	const filePath = join(dir, `${randomUUID()}.${imageExtension(match[1] ?? "png")}`);
	writeFileSync(filePath, Buffer.from(payload, "base64"), { mode: 0o600 });
	return filePath;
}

async function emit(callback: HandlerCallback | undefined, text: string): Promise<void> {
	if (!callback) return;
	await callback({ text, source: "openrouter" }, "GENERATE_IMAGE");
}

function fail(reason: string): ActionResult {
	return { success: false, text: reason, error: reason };
}

const generateImageHandler: Handler = async (runtime, message, _state, options, callback): Promise<ActionResult> => {
	const opts = options && typeof options === "object" ? options as Record<string, unknown> : {};
	const prompt =
		typeof opts.prompt === "string" && opts.prompt.trim().length > 0
			? opts.prompt.trim()
			: typeof message.content.text === "string"
				? message.content.text.trim()
				: "";
	if (!prompt) {
		const text = "GENERATE_IMAGE requires a prompt.";
		await emit(callback, text);
		return fail(text);
	}
	try {
		const images = await openRouterPlugin.models![ModelType.IMAGE]!(runtime, {
			prompt,
			...(typeof opts.size === "string" ? { size: opts.size } : {}),
		}) as OpenRouterImageGenerationResult[];
		const image = images[0];
		if (!image?.url) {
			const text = "Image generation returned no image.";
			await emit(callback, text);
			return fail(text);
		}
		return sendOpenRouterImage(callback, image);
	} catch (error) {
		const reason = `Image generation failed: ${error instanceof Error ? error.message : String(error)}`;
		await emit(callback, reason);
		return fail(reason);
	}
};

async function sendOpenRouterImage(
	callback: HandlerCallback | undefined,
	image: OpenRouterImageGenerationResult,
): Promise<ActionResult> {
	const imageUrl = materializeGeneratedImage(image.url);
	const text = "Generated image.";
	await callback?.({
		text,
		source: "openrouter",
		actions: ["GENERATE_IMAGE"],
		attachments: [{
			id: `generated-image-${randomUUID()}`,
			url: imageUrl,
			title: "Generated image",
			source: "openrouter",
			description: text,
			contentType: ContentType.IMAGE,
		}],
	}, "GENERATE_IMAGE");
	return {
		success: true,
		text,
		values: { generatedImage: true, imageUrl },
		data: {
			actionName: "GENERATE_IMAGE",
			imageUrl,
			...(image.revisedPrompt ? { revisedPrompt: image.revisedPrompt } : {}),
		},
	};
}

export const generateImageAction: Action = {
	name: "GENERATE_IMAGE",
	similes: ["CREATE_IMAGE", "MAKE_IMAGE", "DRAW_IMAGE", "GENERATE_PHOTO", "CREATE_PHOTO"],
	description: "Generate an image from a text prompt and send it back as an image attachment.",
	validate: async () => true,
	handler: generateImageHandler,
	suppressPostActionContinuation: true,
	examples: [],
	parameters: [
		{
			name: "prompt",
			description: "A detailed prompt describing the image to generate.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "size",
			description: "Optional image size or aspect ratio, such as 1024x1024 or 16:9.",
			required: false,
			schema: { type: "string" as const },
		},
	],
	contexts: ["media", "general"],
};

export const openRouterPlugin: Plugin = {
	name: "openrouter",
	description: "OpenRouter chat, embeddings, vision, and image generation via elizaOS model handlers",
	actions: [generateImageAction],
	models: {
		[ModelType.TEXT_LARGE]: async (runtime: IAgentRuntime, params: GenerateTextParams): Promise<string> => {
			return completeText(runtime, pickModel(runtime, "OPENROUTER_MODEL_TEXT_LARGE"), params);
		},
		[ModelType.TEXT_MEDIUM]: async (runtime: IAgentRuntime, params: GenerateTextParams): Promise<string> => {
			return completeText(runtime, pickModel(runtime, "OPENROUTER_MODEL_TEXT_LARGE"), params);
		},
		[ModelType.TEXT_SMALL]: async (runtime: IAgentRuntime, params: GenerateTextParams): Promise<string> => {
			return completeText(runtime, pickModel(runtime, "OPENROUTER_MODEL_TEXT_SMALL"), params);
		},
		[ModelType.OBJECT_LARGE]: (async (
			runtime: IAgentRuntime,
			params: ObjectGenerationParams,
		): Promise<Record<string, unknown>> => {
			const text = await completeText(runtime, pickModel(runtime, "OPENROUTER_MODEL_TEXT_LARGE"), {
				...(params as unknown as GenerateTextParams),
				prompt: `${(params as unknown as GenerateTextParams).prompt ?? ""}\n\nRespond with valid JSON only. Do not wrap it in markdown.`,
			}, { response_format: { type: "json_object" } });
			try {
				const fenced = text.match(/```(?:json)?\s*([\s\S]+?)```/);
				return JSON.parse(fenced ? fenced[1]! : text) as Record<string, unknown>;
			} catch (error) {
				throw new Error(`OpenRouter OBJECT_LARGE response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
			}
		}) as never,
		[ModelType.TEXT_EMBEDDING]: async (
			runtime: IAgentRuntime,
			params: TextEmbeddingParams | string | null,
		): Promise<number[]> => {
			const input = embeddingText(params);
			if (!input) return [];
			const model = pickModel(runtime, "OPENROUTER_MODEL_EMBEDDING", DEFAULT_EMBEDDING_MODEL);
			const response = await postJson(runtime, EMBEDDINGS_URL, { model, input });
			return extractEmbedding(response);
		},
		[ModelType.IMAGE]: async (
			runtime: IAgentRuntime,
			params: ImageGenerationParams,
		): Promise<OpenRouterImageGenerationResult[]> => {
			const model = pickModel(runtime, "OPENROUTER_MODEL_IMAGE", DEFAULT_IMAGE_MODEL);
			const imageConfig: Record<string, string> = {};
			const aspectRatio = normalizeAspectRatio(params.size);
			if (aspectRatio) imageConfig.aspect_ratio = aspectRatio;
			const response = await postJson(runtime, CHAT_URL, {
				model,
				messages: [{ role: "user", content: params.prompt }],
				modalities: imageModalities(model),
				stream: false,
				...(Object.keys(imageConfig).length > 0 ? { image_config: imageConfig } : {}),
			});
			const images = extractImages(response);
			if (images.length === 0) {
				logger.warn({ src: "openrouter", model }, "OpenRouter image response had no message.images entries");
				throw new Error("OpenRouter image generation returned no images");
			}
			return images;
		},
		[ModelType.IMAGE_DESCRIPTION]: async (
			runtime: IAgentRuntime,
			params: ImageDescriptionParams | string,
		): Promise<{ title: string; description: string }> => {
			const input = imageDescriptionInput(params);
			const model = pickModel(runtime, "OPENROUTER_MODEL_VISION", DEFAULT_TEXT_MODEL);
			const response = await postJson(runtime, CHAT_URL, {
				model,
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: input.prompt },
							{ type: "image_url", image_url: { url: input.url, detail: "auto" } },
						],
					},
				],
				stream: false,
			});
			const text = extractText(response);
			return imageDescriptionResult(text);
		},
	},
};

export default openRouterPlugin;
