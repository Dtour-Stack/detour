import {
	ContentType,
	ModelType,
	type Action,
	type ActionResult,
	type HandlerCallback,
	type IAgentRuntime,
	type ImageGenerationResult,
	type Memory,
	type Plugin,
	type Provider,
	type ProviderResult,
	type State,
} from "@elizaos/core";
import { randomUUID } from "node:crypto";
import { saveGeneratedMediaBytes, saveGeneratedMediaUrl } from "../../core/generated-media";
import { localMlxImageEnabled } from "../local-mlx-image";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const ELIZACLOUD_BASE = "https://www.elizacloud.ai/api/v1";
const DEFAULT_OPENROUTER_VIDEO_MODEL = "google/veo-3.1";
const DEFAULT_ELIZACLOUD_IMAGE_MODEL = "google/gemini-2.5-flash-image";
const DEFAULT_ELIZACLOUD_VIDEO_MODEL = "fal-ai/veo3";
const OPENROUTER_VIDEO_POLL_MS = 30_000;
const OPENROUTER_VIDEO_TIMEOUT_MS = 10 * 60_000;

type MediaParams = Record<string, unknown>;
type MediaProvider = "openrouter" | "elizacloud";

type CloudImage = {
	url?: string;
	image?: string;
	mimeType?: string;
};

type CloudImageResponse = {
	images?: CloudImage[];
};

type CloudVideoResponse = {
	id?: string;
	model?: string;
	video?: {
		url?: string;
		content_type?: string;
	};
};

type OpenRouterVideoStatus = {
	id?: string;
	polling_url?: string;
	status?: string;
	generation_id?: string;
	unsigned_urls?: string[];
	error?: string;
};

type OpenRouterVideoJob = {
	id: string;
	pollingUrl: string;
	status: string;
	generationId?: string;
};

export function mediaGenerationSettingKeys(): readonly string[] {
	return [
		"OPENROUTER_MODEL_VIDEO",
		"ELIZAOS_CLOUD_IMAGE_GENERATION_MODEL",
		"ELIZAOS_CLOUD_VIDEO_GENERATION_MODEL",
	];
}

function setting(runtime: IAgentRuntime, key: string, fallback?: string): string | undefined {
	const runtimeValue = runtime.getSetting?.(key);
	if (typeof runtimeValue === "string" && runtimeValue.length > 0) return runtimeValue;
	const envValue = process.env[key];
	if (typeof envValue === "string" && envValue.length > 0) return envValue;
	return fallback;
}

function requireSetting(runtime: IAgentRuntime, key: string, label: string): string {
	const value = setting(runtime, key);
	if (!value) throw new Error(`${key} is not configured. Add ${label} in Settings -> Providers.`);
	return value;
}

function paramsFrom(message: Memory, options?: Record<string, unknown>): MediaParams {
	const content = message.content && typeof message.content === "object"
		? message.content as Record<string, unknown>
		: {};
	const parameters = options?.parameters && typeof options.parameters === "object" && !Array.isArray(options.parameters)
		? options.parameters as Record<string, unknown>
		: {};
	return { ...content, ...(options ?? {}), ...parameters };
}

function firstString(params: MediaParams, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = params[key];
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return undefined;
}

function firstNumber(params: MediaParams, keys: readonly string[]): number | undefined {
	for (const key of keys) {
		const value = params[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && value.trim().length > 0) {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) return parsed;
		}
	}
	return undefined;
}

function firstBool(params: MediaParams, keys: readonly string[]): boolean | undefined {
	for (const key of keys) {
		const value = params[key];
		if (typeof value === "boolean") return value;
		if (typeof value === "string") {
			const lower = value.toLowerCase();
			if (lower === "true" || lower === "1" || lower === "yes") return true;
			if (lower === "false" || lower === "0" || lower === "no") return false;
		}
	}
	return undefined;
}

function promptFrom(message: Memory, params: MediaParams): string {
	const prompt = firstString(params, ["prompt", "text", "description"]);
	if (prompt) return prompt;
	const text = typeof message.content?.text === "string" ? message.content.text.trim() : "";
	if (!text) throw new Error("A prompt is required.");
	return text.replace(/^\/(?:video|image)\s+/i, "").trim();
}

function requestedProvider(params: MediaParams): MediaProvider | undefined {
	const raw = firstString(params, ["provider", "mediaProvider"]);
	if (!raw) return undefined;
	const normalized = raw.toLowerCase().replace(/[^a-z]/g, "");
	if (normalized === "openrouter") return "openrouter";
	if (normalized === "elizacloud" || normalized === "elizaoscloud" || normalized === "cloud") return "elizacloud";
	throw new Error(`Unsupported media provider: ${raw}`);
}

function defaultVideoProvider(runtime: IAgentRuntime, params: MediaParams): MediaProvider {
	const provider = requestedProvider(params);
	if (provider) return provider;
	if (setting(runtime, "ELIZAOS_CLOUD_API_KEY")) return "elizacloud";
	if (setting(runtime, "OPENROUTER_API_KEY")) return "openrouter";
	throw new Error("Configure ELIZAOS_CLOUD_API_KEY or OPENROUTER_API_KEY before generating video.");
}

function cloudBase(runtime: IAgentRuntime): string {
	return (setting(runtime, "ELIZAOS_CLOUD_BASE_URL", ELIZACLOUD_BASE) ?? ELIZACLOUD_BASE).replace(/\/+$/, "");
}

function openRouterHeaders(runtime: IAgentRuntime): HeadersInit {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${requireSetting(runtime, "OPENROUTER_API_KEY", "an OpenRouter API key")}`,
		"Content-Type": "application/json",
	};
	const referer = setting(runtime, "OPENROUTER_SITE_URL");
	const title = setting(runtime, "OPENROUTER_APP_NAME", "Detour");
	if (referer) headers["HTTP-Referer"] = referer;
	if (title) headers["X-OpenRouter-Title"] = title;
	return headers;
}

function cloudHeaders(runtime: IAgentRuntime): HeadersInit {
	return {
		Authorization: `Bearer ${requireSetting(runtime, "ELIZAOS_CLOUD_API_KEY", "an ElizaCloud API key")}`,
		"Content-Type": "application/json",
	};
}

async function jsonFetch<T>(url: string, init: RequestInit): Promise<T> {
	const response = await fetch(url, init);
	if (!response.ok) {
		const body = await response.text().catch(() => response.statusText);
		throw new Error(`HTTP ${response.status}: ${body.slice(0, 500)}`);
	}
	return await response.json() as T;
}

async function emit(callback: HandlerCallback | undefined, text: string, content?: unknown, action = "GENERATE_VIDEO"): Promise<void> {
	if (!callback) return;
	await callback({ text, content } as never, action);
}

function ok(text: string, values: Record<string, unknown>): ActionResult {
	return { success: true, text, values: values as never, data: values as never };
}

function fail(text: string): ActionResult {
	return { success: false, text, error: text };
}

function validateText(pattern: RegExp): Action["validate"] {
	return async (_runtime, message) => pattern.test((message.content?.text ?? "").toLowerCase());
}

function imageReference(url: string): { type: "image_url"; image_url: { url: string } } {
	return { type: "image_url", image_url: { url } };
}

function frameImage(url: string, frameType: "first_frame" | "last_frame") {
	return { ...imageReference(url), frame_type: frameType };
}

function openRouterVideoBody(runtime: IAgentRuntime, params: MediaParams, prompt: string): Record<string, unknown> {
	const model = firstString(params, ["model", "modelId", "model_id"]) ?? setting(runtime, "OPENROUTER_MODEL_VIDEO", DEFAULT_OPENROUTER_VIDEO_MODEL)!;
	const body: Record<string, unknown> = { model, prompt };
	const aspectRatio = firstString(params, ["aspectRatio", "aspect_ratio"]);
	if (aspectRatio) body.aspect_ratio = aspectRatio;
	const resolution = firstString(params, ["resolution"]);
	if (resolution) body.resolution = resolution;
	const size = firstString(params, ["size"]);
	if (size) body.size = size;
	const duration = firstNumber(params, ["duration", "durationSeconds", "duration_seconds"]);
	if (duration !== undefined) body.duration = Math.round(duration);
	const seed = firstNumber(params, ["seed"]);
	if (seed !== undefined) body.seed = Math.round(seed);
	const generateAudio = firstBool(params, ["generateAudio", "generate_audio", "audio"]);
	if (generateAudio !== undefined) body.generate_audio = generateAudio;
	const firstFrame = firstString(params, ["firstFrameUrl", "first_frame_url", "imageUrl", "image_url"]);
	const lastFrame = firstString(params, ["lastFrameUrl", "last_frame_url"]);
	const frames = [
		...(firstFrame ? [frameImage(firstFrame, "first_frame")] : []),
		...(lastFrame ? [frameImage(lastFrame, "last_frame")] : []),
	];
	if (frames.length > 0) body.frame_images = frames;
	const referenceUrl = firstString(params, ["referenceUrl", "reference_url"]);
	if (referenceUrl) body.input_references = [imageReference(referenceUrl)];
	return body;
}

async function submitOpenRouterVideo(
	runtime: IAgentRuntime,
	params: MediaParams,
	prompt: string,
	callback: HandlerCallback | undefined,
): Promise<{ provider: "openrouter"; media?: Awaited<ReturnType<typeof saveGeneratedMediaUrl>>; job: OpenRouterVideoJob; status: OpenRouterVideoStatus }> {
	const body = openRouterVideoBody(runtime, params, prompt);
	const submit = await jsonFetch<OpenRouterVideoStatus>(`${OPENROUTER_BASE}/videos`, {
		method: "POST",
		headers: openRouterHeaders(runtime),
		body: JSON.stringify(body),
	});
	const id = submit.id;
	const pollingUrl = submit.polling_url ? resolveOpenRouterUrl(submit.polling_url) : id ? `${OPENROUTER_BASE}/videos/${encodeURIComponent(id)}` : "";
	if (!id || !pollingUrl) throw new Error("OpenRouter video response missing id or polling_url.");
	const job: OpenRouterVideoJob = {
		id,
		pollingUrl,
		status: submit.status ?? "pending",
		...(submit.generation_id ? { generationId: submit.generation_id } : {}),
	};
	await emit(callback, `OpenRouter video job submitted: ${job.id}. Polling until it completes.`, job);
	const waitForCompletion = firstBool(params, ["waitForCompletion", "wait_for_completion"]);
	if (waitForCompletion === false) return { provider: "openrouter", job, status: submit };
	const status = await pollOpenRouterVideo(runtime, pollingUrl, callback);
	const unsignedUrl = status.unsigned_urls?.[0];
	const media = unsignedUrl
		? await saveGeneratedMediaUrl({
			kind: "video",
			provider: "openrouter",
			capability: "video-generation",
			url: resolveOpenRouterUrl(unsignedUrl),
			title: "OpenRouter generated video",
			prompt,
			model: typeof body.model === "string" ? body.model : undefined,
		})
		: await downloadOpenRouterVideoContent(runtime, id, prompt, typeof body.model === "string" ? body.model : undefined);
	return { provider: "openrouter", media, job, status };
}

async function downloadOpenRouterVideoContent(
	runtime: IAgentRuntime,
	id: string,
	prompt: string,
	model: string | undefined,
) {
	const response = await fetch(`${OPENROUTER_BASE}/videos/${encodeURIComponent(id)}/content?index=0`, {
		headers: openRouterHeaders(runtime),
	});
	if (!response.ok) {
		const body = await response.text().catch(() => response.statusText);
		throw new Error(`OpenRouter video content HTTP ${response.status}: ${body.slice(0, 240)}`);
	}
	const contentType = response.headers.get("content-type") ?? "video/mp4";
	const bytes = new Uint8Array(await response.arrayBuffer());
	return saveGeneratedMediaBytes({
		kind: "video",
		provider: "openrouter",
		capability: "video-generation",
		title: "OpenRouter generated video",
		prompt,
		...(model ? { model } : {}),
		bytes,
		contentType,
	});
}

async function pollOpenRouterVideo(
	runtime: IAgentRuntime,
	pollingUrl: string,
	callback: HandlerCallback | undefined,
): Promise<OpenRouterVideoStatus> {
	const deadline = Date.now() + OPENROUTER_VIDEO_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, OPENROUTER_VIDEO_POLL_MS));
		const status = await jsonFetch<OpenRouterVideoStatus>(pollingUrl, {
			method: "GET",
			headers: openRouterHeaders(runtime),
		});
		await emit(callback, `OpenRouter video status: ${status.status ?? "unknown"}`, status);
		if (status.status === "completed") return status;
		if (status.status === "failed" || status.status === "cancelled" || status.status === "expired") {
			throw new Error(`OpenRouter video ${status.status}: ${status.error ?? "no error detail"}`);
		}
	}
	throw new Error("OpenRouter video generation timed out while polling.");
}

function resolveOpenRouterUrl(url: string): string {
	if (/^https?:\/\//i.test(url)) return url;
	return new URL(url, "https://openrouter.ai").toString();
}

async function generateElizaCloudVideo(
	runtime: IAgentRuntime,
	params: MediaParams,
	prompt: string,
): Promise<{ media: Awaited<ReturnType<typeof saveGeneratedMediaUrl>>; response: CloudVideoResponse }> {
	const model = firstString(params, ["model", "modelId", "model_id"]) ?? setting(runtime, "ELIZAOS_CLOUD_VIDEO_GENERATION_MODEL", DEFAULT_ELIZACLOUD_VIDEO_MODEL)!;
	const body: Record<string, unknown> = { prompt, model };
	const referenceUrl = firstString(params, ["referenceUrl", "reference_url", "imageUrl", "image_url"]);
	if (referenceUrl) body.referenceUrl = referenceUrl;
	const duration = firstNumber(params, ["durationSeconds", "duration_seconds", "duration"]);
	if (duration !== undefined) body.durationSeconds = duration;
	const resolution = firstString(params, ["resolution"]);
	if (resolution) body.resolution = resolution;
	const audio = firstBool(params, ["audio", "generateAudio", "generate_audio"]);
	if (audio !== undefined) body.audio = audio;
	const response = await jsonFetch<CloudVideoResponse>(`${cloudBase(runtime)}/generate-video`, {
		method: "POST",
		headers: cloudHeaders(runtime),
		body: JSON.stringify(body),
	});
	const url = response.video?.url;
	if (!url) throw new Error("ElizaCloud returned no video URL.");
	const media = await saveGeneratedMediaUrl({
		kind: "video",
		provider: "elizacloud",
		capability: "video-generation",
		url,
		contentType: response.video?.content_type,
		title: "ElizaCloud generated video",
		prompt,
		model: response.model ?? model,
	});
	return { media, response };
}

async function generateElizaCloudImages(
	runtime: IAgentRuntime,
	params: MediaParams,
	prompt: string,
): Promise<{ media: Awaited<ReturnType<typeof saveGeneratedMediaUrl>>[]; response: CloudImageResponse }> {
	const model = firstString(params, ["model", "modelId", "model_id"]) ?? setting(runtime, "ELIZAOS_CLOUD_IMAGE_GENERATION_MODEL", DEFAULT_ELIZACLOUD_IMAGE_MODEL)!;
	const body: Record<string, unknown> = {
		prompt,
		model,
		numImages: Math.max(1, Math.min(4, Math.round(firstNumber(params, ["numImages", "count", "n"]) ?? 1))),
	};
	const aspectRatio = firstString(params, ["aspectRatio", "aspect_ratio", "size"]);
	if (aspectRatio) body.aspectRatio = aspectRatio;
	const stylePreset = firstString(params, ["stylePreset", "style_preset"]);
	if (stylePreset) body.stylePreset = stylePreset;
	const sourceImage = firstString(params, ["sourceImage", "source_image", "imageUrl", "image_url"]);
	if (sourceImage) body.sourceImage = sourceImage;
	const response = await jsonFetch<CloudImageResponse>(`${cloudBase(runtime)}/generate-image`, {
		method: "POST",
		headers: cloudHeaders(runtime),
		body: JSON.stringify(body),
	});
	const images = response.images ?? [];
	if (images.length === 0) throw new Error("ElizaCloud returned no images.");
	const media = [];
	for (const image of images) {
		const url = image.url ?? image.image;
		if (!url) continue;
		media.push(await saveGeneratedMediaUrl({
			kind: "image",
			provider: "elizacloud",
			capability: "image-generation",
			url,
			contentType: image.mimeType,
			title: "ElizaCloud generated image",
			prompt,
			model,
		}));
	}
	if (media.length === 0) throw new Error("ElizaCloud image response had no usable URLs.");
	return { media, response };
}

async function videoHandler(
	provider: MediaProvider | null,
	runtime: IAgentRuntime,
	message: Memory,
	options: Record<string, unknown> | undefined,
	callback: HandlerCallback | undefined,
): Promise<ActionResult> {
	try {
		const params = paramsFrom(message, options);
		const prompt = promptFrom(message, params);
		// Local video is not supported (removed — MLX-Swift ports don't
		// exist and the SDXL-stitch experiment was unworkable on 16GB
		// machines). Cloud is the only video path.
		const selected = provider ?? defaultVideoProvider(runtime, params);
		if (selected === "openrouter") {
			const result = await submitOpenRouterVideo(runtime, params, prompt, callback);
			if (!result.media) {
				const text = `OpenRouter video job submitted: ${result.job.id}`;
				return ok(text, { provider: "openrouter", job: result.job, status: result.status });
			}
			const text = `Generated OpenRouter video: ${result.media.path}`;
			await emit(callback, text, result.media);
			return ok(text, { provider: "openrouter", video: result.media, job: result.job, status: result.status });
		}
		const result = await generateElizaCloudVideo(runtime, params, prompt);
		const text = `Generated ElizaCloud video: ${result.media.path}`;
		await emit(callback, text, result.media);
		return ok(text, { provider: "elizacloud", video: result.media, response: result.response });
	} catch (err) {
		const text = `Video generation failed: ${err instanceof Error ? err.message : String(err)}`;
		await emit(callback, text);
		return fail(text);
	}
}

async function elizaCloudImageHandler(
	runtime: IAgentRuntime,
	message: Memory,
	options: Record<string, unknown> | undefined,
	callback: HandlerCallback | undefined,
): Promise<ActionResult> {
	try {
		const params = paramsFrom(message, options);
		const prompt = promptFrom(message, params);
		// When local MLX image gen is active, route through useModel so
		// the priority resolver picks the local-mlx-image handler
		// (registered with priority 100). The cloud path below stays as
		// fallback if local generation throws or is not enabled.
		if (localMlxImageEnabled(runtime)) {
			try {
				const localImages = await runtime.useModel(ModelType.IMAGE, {
					prompt,
					size: firstString(params, ["size", "aspectRatio", "aspect_ratio"]) as string | undefined,
					count: firstNumber(params, ["numImages", "count", "n"]) as number | undefined,
				}) as ImageGenerationResult[];
				if (localImages && localImages.length > 0) {
					const text = localImages.length === 1 ? "Generated image (local MLX)." : `Generated ${localImages.length} images (local MLX).`;
					await callback?.({
						text,
						source: "local-mlx",
						actions: ["GENERATE_IMAGE"],
						attachments: localImages.map((image) => ({
							id: `generated-image-${randomUUID()}`,
							url: image.url,
							title: "Local MLX generated image",
							source: "local-mlx",
							description: prompt,
							contentType: ContentType.IMAGE,
						})),
					}, "GENERATE_IMAGE");
					return ok(text, {
						provider: "local-mlx",
						images: localImages,
						imageUrl: localImages[0]?.url,
					});
				}
			} catch (localErr) {
				const reason = localErr instanceof Error ? localErr.message : String(localErr);
				await emit(callback, `Local MLX image gen failed (${reason}); falling back to ElizaCloud.`);
			}
		}
		const result = await generateElizaCloudImages(runtime, params, prompt);
		const text = result.media.length === 1 ? "Generated image." : `Generated ${result.media.length} images.`;
		await callback?.({
			text,
			source: "elizacloud",
			actions: ["GENERATE_IMAGE"],
			attachments: result.media.map((item) => ({
				id: `generated-image-${randomUUID()}`,
				url: item.url,
				title: item.title,
				source: "elizacloud",
				description: prompt,
				contentType: ContentType.IMAGE,
			})),
		}, "GENERATE_IMAGE");
		return ok(text, {
			provider: "elizacloud",
			images: result.media,
			response: result.response,
			imageUrl: result.media[0]?.url,
			galleryId: result.media[0]?.id,
		});
	} catch (err) {
		const text = `ElizaCloud image generation failed: ${err instanceof Error ? err.message : String(err)}`;
		await emit(callback, text, undefined, "GENERATE_IMAGE");
		return fail(text);
	}
}

export const generateVideoAction: Action = {
	name: "GENERATE_VIDEO",
	similes: ["CREATE_VIDEO", "MAKE_VIDEO", "TEXT_TO_VIDEO", "IMAGE_TO_VIDEO"],
	description:
		"Generate a video with ElizaCloud or OpenRouter and store the result in the Detour Gallery.",
	descriptionCompressed: "Generate video with ElizaCloud/OpenRouter and save to Gallery.",
	parameters: [
		{ name: "prompt", description: "Video prompt.", required: true, schema: { type: "string" } },
		{ name: "provider", description: "openrouter or elizacloud.", required: false, schema: { type: "string" } },
		{ name: "model", description: "Provider video model id.", required: false, schema: { type: "string" } },
		{ name: "aspectRatio", description: "Aspect ratio, such as 16:9 or 9:16.", required: false, schema: { type: "string" } },
		{ name: "duration", description: "Duration in seconds.", required: false, schema: { type: "number" } },
	],
	validate: validateText(/\b(generate|create|make|render).{0,40}\b(video|clip|movie|animation)\b|\b(text to video|image to video)\b/),
	handler: (runtime, message, _state, options, callback) => videoHandler(null, runtime, message, options, callback),
	suppressPostActionContinuation: true,
	examples: [],
	contexts: ["media", "general"],
};

export const openRouterGenerateVideoAction: Action = {
	...generateVideoAction,
	name: "OPENROUTER_GENERATE_VIDEO",
	similes: ["OPENROUTER_VIDEO", "OPENROUTER_TEXT_TO_VIDEO", "OPENROUTER_IMAGE_TO_VIDEO"],
	description: "Generate a video with OpenRouter's async video endpoint and store it in the Detour Gallery.",
	handler: (runtime, message, _state, options, callback) => videoHandler("openrouter", runtime, message, options, callback),
};

export const elizaCloudGenerateVideoAction: Action = {
	...generateVideoAction,
	name: "ELIZACLOUD_GENERATE_VIDEO",
	similes: ["ELIZAOS_CLOUD_GENERATE_VIDEO", "ELIZACLOUD_VIDEO", "CLOUD_GENERATE_VIDEO"],
	description: "Generate a video with ElizaCloud and store it in the Detour Gallery.",
	handler: (runtime, message, _state, options, callback) => videoHandler("elizacloud", runtime, message, options, callback),
};

export const elizaCloudGenerateImageAction: Action = {
	name: "GENERATE_IMAGE",
	similes: ["ELIZACLOUD_GENERATE_IMAGE", "ELIZAOS_CLOUD_GENERATE_IMAGE", "CREATE_IMAGE", "MAKE_IMAGE", "DRAW_IMAGE"],
	description:
		"Generate an image through ElizaCloud and store it in the Detour Gallery. Used when no active provider-specific GENERATE_IMAGE action is already registered.",
	descriptionCompressed: "Generate ElizaCloud images and save to Gallery.",
	parameters: [
		{ name: "prompt", description: "Image prompt.", required: true, schema: { type: "string" } },
		{ name: "model", description: "ElizaCloud image model id.", required: false, schema: { type: "string" } },
		{ name: "aspectRatio", description: "Aspect ratio, such as 1:1, 16:9, or 9:16.", required: false, schema: { type: "string" } },
		{ name: "numImages", description: "Number of images, 1-4.", required: false, schema: { type: "number" } },
	],
	validate: validateText(/\b(generate|create|make|draw|render).{0,40}\b(image|picture|photo|art)\b/),
	handler: (runtime, message, _state, options, callback) => elizaCloudImageHandler(runtime, message, options, callback),
	suppressPostActionContinuation: true,
	examples: [],
	contexts: ["media", "general"],
};

export const mediaGenerationStatusProvider: Provider = {
	name: "MEDIA_GENERATION_STATUS",
	description: "Configured image/video/audio generation providers and gallery storage.",
	descriptionCompressed: "media generation provider status and gallery capability.",
	position: -44,
	get: async (runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> => {
		const elizaCloudConfigured = Boolean(setting(runtime, "ELIZAOS_CLOUD_API_KEY"));
		const openRouterConfigured = Boolean(setting(runtime, "OPENROUTER_API_KEY"));
		const localMlxImage = localMlxImageEnabled(runtime);
		return {
			text: [
				"# Media generation status",
				`Local MLX image: ${localMlxImage ? "ACTIVE (priority 100 — wins over cloud)" : "disabled"}.`,
				`Video: cloud only (Veo via OpenRouter, Veo3 via ElizaCloud). No local video path.`,
				`ElizaCloud: ${elizaCloudConfigured ? "configured" : "missing ELIZAOS_CLOUD_API_KEY"}; image + video generation available when configured.`,
				`OpenRouter: ${openRouterConfigured ? "configured" : "missing OPENROUTER_API_KEY"}; image generation plus async video generation available when configured.`,
				"Gallery: every generated image, video, and audio file is stored under ~/.detour/generated-media and visible in the Detour Gallery.",
				"Actions: GENERATE_IMAGE, GENERATE_VIDEO, OPENROUTER_GENERATE_VIDEO, ELIZACLOUD_GENERATE_VIDEO.",
			].join("\n"),
			values: { elizaCloudConfigured, openRouterConfigured, localMlxImage },
		};
	},
};

export const mediaGenerationPlugin: Plugin = {
	name: "media-generation",
	description: "Image/video generation wrappers plus generated-media gallery storage.",
	actions: [
		generateVideoAction,
		openRouterGenerateVideoAction,
		elizaCloudGenerateVideoAction,
		elizaCloudGenerateImageAction,
	],
	providers: [mediaGenerationStatusProvider],
};

export default mediaGenerationPlugin;
