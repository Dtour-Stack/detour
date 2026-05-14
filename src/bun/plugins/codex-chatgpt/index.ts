/**
 * @detour/plugin-codex-chatgpt
 *
 * Drives elizaOS chat + image generation via the OpenAI Codex CLI's
 * ChatGPT-subscription auth path (https://chatgpt.com/backend-api/codex/responses).
 *
 * Required env (set by RuntimeService before plugin init):
 *   - CODEX_OAUTH_TOKEN      OAuth access_token (`eyJ…` JWT)
 *   - CODEX_CHATGPT_ACCOUNT_ID  optional override; otherwise read from JWT claim
 *   - CODEX_MODEL_LARGE      default text model (default: "gpt-5.2")
 *   - CODEX_MODEL_SMALL      faster model       (default: "gpt-5.2")
 *   - CODEX_MODEL_IMAGE      image-gen carrier  (default: "gpt-5.2")
 */

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
} from "@elizaos/core";
import { randomUUID } from "node:crypto";
import { saveGeneratedMediaUrl } from "../../core/generated-media";
import {
	CodexResponsesClient,
	type CreateResponseRequest,
	type ResponsesInputItem,
	type ResponsesContentItem,
} from "./responses-client";
import { QuotaExceededError } from "./quota-error";
import { getProviderQuotaService } from "../../core/provider-quota-service";

type CodexImageGenerationParams = ImageGenerationParams & {
	quality?: "low" | "medium" | "high" | "auto";
	n?: number;
};

type CodexImageGenerationResult = ImageGenerationResult & {
	revisedPrompt?: string;
};

function getSetting(runtime: IAgentRuntime, key: string, fallback?: string): string | undefined {
	const v = runtime.getSetting(key);
	if (typeof v === "string" && v.length > 0) return v;
	const env = process.env[key];
	if (typeof env === "string" && env.length > 0) return env;
	return fallback;
}

function buildClient(runtime: IAgentRuntime): CodexResponsesClient {
	const token = getSetting(runtime, "CODEX_OAUTH_TOKEN");
	if (!token) {
		throw new Error(
			"plugin-codex-chatgpt: CODEX_OAUTH_TOKEN is not set. Run the openai-codex OAuth flow and pass the token via runtime settings.",
		);
	}
	const acct = getSetting(runtime, "CODEX_CHATGPT_ACCOUNT_ID");
	return new CodexResponsesClient({ accessToken: token, ...(acct ? { chatgptAccountId: acct } : {}) });
}

/**
 * Centralised quota-cap recording. Every Codex Responses API call funnels
 * through here so the runtime sees the same cap state regardless of which
 * model handler triggered the upstream error (text/object/image/vision).
 *
 * Uses the active credential identity from env (set by RuntimeService when
 * preparing the provider attempt). Falls back to "primary" when env is
 * empty — keeps the cap scoped to *something* so we don't lose the state.
 */
function recordQuotaCap(err: unknown, runtime: IAgentRuntime): void {
	if (!(err instanceof QuotaExceededError)) return;
	const accountId = getSetting(runtime, "CODEX_CHATGPT_ACCOUNT_ID") ?? "primary";
	const accountLabel = getSetting(runtime, "CODEX_ACCOUNT_LABEL") ?? "Codex Pro";
	getProviderQuotaService().mark({
		providerId: "openai",
		accountId,
		accountLabel,
		kind: "plan_quota",
		planType: err.planType,
		resetsAtMs: err.resetsAtMs,
		upstreamMessage: err.upstreamMessage,
	});
	logger.warn(
		{
			src: "codex-chatgpt",
			accountId,
			planType: err.planType,
			resetsAt: new Date(err.resetsAtMs).toISOString(),
		},
		"Codex Pro usage limit reached — recorded on ProviderQuotaService",
	);
}

function pickModel(runtime: IAgentRuntime, key: string, fallback: string): string {
	return getSetting(runtime, key, fallback) ?? fallback;
}

function paramsBag(options: Record<string, unknown> | undefined): Record<string, unknown> {
	if (!options) return {};
	const params = options.parameters;
	if (params && typeof params === "object" && !Array.isArray(params)) return params as Record<string, unknown>;
	return {};
}

function pickString(options: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
	if (!options) return undefined;
	const params = paramsBag(options);
	for (const key of keys) {
		const value = params[key];
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	for (const key of keys) {
		const value = options[key];
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return undefined;
}

function normalizeImageSize(size: string | undefined): string {
	if (!size) return "1024x1024";
	const trimmed = size.trim().toLowerCase();
	if (trimmed === "auto") return "1024x1024";
	const match = trimmed.match(/^(\d{3,4})x(\d{3,4})$/);
	if (!match) return trimmed;
	const width = Number(match[1]);
	const height = Number(match[2]);
	return width * height < 1024 * 1024 ? "1024x1024" : trimmed;
}

async function emit(callback: HandlerCallback | undefined, text: string): Promise<void> {
	if (!callback) return;
	await callback({ text, source: "codex-chatgpt" }, "GENERATE_IMAGE");
}

function fail(reason: string): ActionResult {
	return { success: false, text: reason, error: reason };
}

function buildInput(params: GenerateTextParams): {
	instructions: string | undefined;
	input: ResponsesInputItem[];
} {
	// Eliza's GenerateTextParams typically passes a single `prompt` string +
	// optional `messages` for chat history. Normalize to Responses API format.
	const items: ResponsesInputItem[] = [];
	const messages = (params as unknown as { messages?: Array<{ role: string; content: string }> }).messages;
	if (Array.isArray(messages) && messages.length > 0) {
		for (const m of messages) {
			if (m.role === "system") continue; // system → instructions below
			const role = m.role === "assistant" ? "assistant" : "user";
			const contentItem: ResponsesContentItem =
				role === "assistant"
					? { type: "output_text", text: m.content ?? "" }
					: { type: "input_text", text: m.content ?? "" };
			items.push({ type: "message", role, content: [contentItem] });
		}
	}
	if (typeof params.prompt === "string" && params.prompt.length > 0) {
		items.push({ type: "message", role: "user", content: [{ type: "input_text", text: params.prompt }] });
	}
	const sysFromMessages = messages?.find((m) => m.role === "system")?.content;
	const instructions = (params as unknown as { system?: string }).system ?? sysFromMessages;
	return { instructions, input: items };
}

async function streamText(runtime: IAgentRuntime, model: string, params: GenerateTextParams): Promise<string> {
	const client = buildClient(runtime);
	const { instructions, input } = buildInput(params);
	const req: CreateResponseRequest = {
		model,
		input,
		stream: true,
		store: false,
		// `/codex/responses` REQUIRES an `instructions` string — sending an
		// empty body or omitting the field both yield 400 "Instructions are
		// required". Fall back to a minimal default so the call succeeds even
		// when the caller (and the prompt's system message) didn't provide one.
		instructions: instructions ?? "You are a helpful assistant.",
		// Codex Responses API rejects BOTH `temperature` AND `max_output_tokens`
		// with HTTP 400 ("Unsupported parameter: …"). Eliza's planner +
		// evaluators pass both in their generateText params; we silently drop
		// them here so every LLM call doesn't 400-fail (which causes
		// trajectory.llmCallCount=0 and the agent to never reply / never act).
	};

	let collected = "";
	try {
		for await (const ev of client.stream(req)) {
			if (ev.type === "response.output_text.delta") {
				const delta = (ev as { delta?: string }).delta ?? "";
				collected += delta;
			} else if (ev.type === "response.output_text.done") {
				const text = (ev as { text?: string }).text ?? "";
				if (collected.length === 0 && text.length > 0) collected = text;
			} else if (ev.type === "response.failed" || ev.type === "response.error") {
				const errMessage =
					(ev as { response?: { error?: { message?: string } }; error?: { message?: string } }).response?.error?.message ??
					(ev as { error?: { message?: string } }).error?.message ??
					"Codex Responses API error";
				throw new Error(errMessage);
			}
		}
	} catch (err) {
		recordQuotaCap(err, runtime);
		throw err;
	}
	return collected;
}

const generateImageHandler: Handler = async (runtime, message, _state, options, callback): Promise<ActionResult> => {
	const opts = options as Record<string, unknown> | undefined;
	const prompt =
		pickString(opts, ["prompt", "description", "imagePrompt", "text"]) ??
		(typeof message.content.text === "string" ? message.content.text.trim() : undefined);
	if (!prompt) {
		const text = "GENERATE_IMAGE requires a prompt.";
		await emit(callback, text);
		return fail(text);
	}

	try {
		const size = pickString(opts, ["size", "dimensions"]);
		const params: ImageGenerationParams = {
			prompt,
			size: normalizeImageSize(size),
		};
		const images = (await runtime.useModel(ModelType.IMAGE, params)) as CodexImageGenerationResult[];
		const image = images[0];
		if (!image?.url) {
			const text = "Image generation returned no image.";
			await emit(callback, text);
			return fail(text);
		}
		const media = await saveGeneratedMediaUrl({
			kind: "image",
			provider: "codex-chatgpt",
			capability: "image-generation",
			url: image.url,
			title: "Codex generated image",
			prompt,
			model: pickModel(runtime, "CODEX_MODEL_IMAGE", "gpt-5.2"),
		});
		const attachmentUrl = media.url;
		const text = "Generated image.";
		if (callback) {
			await callback(
				{
					text,
					source: "codex-chatgpt",
					actions: ["GENERATE_IMAGE"],
					attachments: [
						{
							id: `generated-image-${randomUUID()}`,
							url: attachmentUrl,
							title: "Generated image",
							source: "codex-chatgpt",
							description: text,
							contentType: ContentType.IMAGE,
						},
					],
				},
				"GENERATE_IMAGE",
			);
		}
		return {
			success: true,
			text,
			values: { generatedImage: true, imageUrl: attachmentUrl, galleryId: media.id },
			data: {
				actionName: "GENERATE_IMAGE",
				imageUrl: attachmentUrl,
				galleryId: media.id,
				...(image.revisedPrompt ? { revisedPrompt: image.revisedPrompt } : {}),
			},
		};
	} catch (error) {
		const reason = `Image generation failed: ${error instanceof Error ? error.message : String(error)}`;
		await emit(callback, reason);
		return fail(reason);
	}
};

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
			description: "Optional image size, such as 1024x1024.",
			required: false,
			schema: { type: "string" as const },
		},
	],
	contexts: ["media", "general"],
};

export const codexChatGptPlugin: Plugin = {
	name: "codex-chatgpt",
	description: "OpenAI Codex via ChatGPT subscription OAuth (chatgpt.com/backend-api/codex/responses)",
	actions: [generateImageAction],

	models: {
		// Text — all three size buckets route through Responses API; pick model
		// names per-bucket via env so users can map LARGE→gpt-5.5, SMALL→gpt-5.4-mini etc.
		[ModelType.TEXT_LARGE]: async (runtime: IAgentRuntime, params: GenerateTextParams): Promise<string> => {
			const model = pickModel(runtime, "CODEX_MODEL_LARGE", "gpt-5.2");
			return streamText(runtime, model, params);
		},
		[ModelType.TEXT_MEDIUM]: async (runtime: IAgentRuntime, params: GenerateTextParams): Promise<string> => {
			const model = pickModel(runtime, "CODEX_MODEL_LARGE", "gpt-5.2");
			return streamText(runtime, model, params);
		},
		[ModelType.TEXT_SMALL]: async (runtime: IAgentRuntime, params: GenerateTextParams): Promise<string> => {
			const model = pickModel(runtime, "CODEX_MODEL_SMALL", "gpt-5.2");
			return streamText(runtime, model, params);
		},

		// Object mode — same call but ask for JSON output. The Responses API
		// supports a `response_format`-equivalent via tool/response_format; for
		// simplicity we instruct the model and parse the output text.
		[ModelType.OBJECT_LARGE]: (async (
			runtime: IAgentRuntime,
			params: ObjectGenerationParams,
		): Promise<Record<string, unknown>> => {
			const model = pickModel(runtime, "CODEX_MODEL_LARGE", "gpt-5.2");
			const text = await streamText(runtime, model, {
				...(params as unknown as GenerateTextParams),
				prompt: `${(params as unknown as GenerateTextParams).prompt ?? ""}\n\nRespond with valid JSON only — no markdown, no commentary.`,
			});
			try {
				const fenced = text.match(/```(?:json)?\s*([\s\S]+?)```/);
				return JSON.parse(fenced ? fenced[1]! : text) as Record<string, unknown>;
			} catch (err) {
				throw new Error(
					`plugin-codex-chatgpt: OBJECT_LARGE response was not valid JSON: ${err instanceof Error ? err.message : err}\n---\n${text.slice(0, 400)}`,
				);
			}
		}) as never,

		// Image generation — uses the Responses API's built-in image_generation tool.
		// Returns base64-encoded PNG payloads. Codex requires stream:true here
		// too — the image_generation_call output item arrives as a stream
		// event we need to capture.
		[ModelType.IMAGE]: async (
			runtime: IAgentRuntime,
			params: CodexImageGenerationParams,
		): Promise<CodexImageGenerationResult[]> => {
			const client = buildClient(runtime);
			const model = pickModel(runtime, "CODEX_MODEL_IMAGE", "gpt-5.2");
			const req: CreateResponseRequest = {
				model,
				input: [{ type: "message", role: "user", content: [{ type: "input_text", text: params.prompt }] }],
				tools: [
					{
						type: "image_generation",
						quality: params.quality ?? "auto",
						size: normalizeImageSize(params.size),
					},
				],
				instructions: "You are an image generation assistant. Generate an image matching the user's request.",
				stream: true,
				store: false,
			};
			const images: Array<{ url: string; revisedPrompt?: string }> = [];
			try {
				for await (const ev of client.stream(req)) {
					// Image generation outputs come through as `response.completed`
					// or `response.output_item.done` carrying the full output array.
					const anyEv = ev as unknown as { type?: string; response?: { output?: Array<Record<string, unknown>> }; item?: Record<string, unknown> };
					const items: Array<Record<string, unknown>> = [];
					if (anyEv.response?.output) items.push(...anyEv.response.output);
					if (anyEv.item) items.push(anyEv.item);
					for (const item of items) {
						if (item.type === "image_generation_call" && typeof item.result === "string") {
							const url = `data:image/png;base64,${item.result as string}`;
							const entry: { url: string; revisedPrompt?: string } = { url };
							if (typeof item.revised_prompt === "string") entry.revisedPrompt = item.revised_prompt as string;
							images.push(entry);
						}
					}
					if (anyEv.type === "response.failed" || anyEv.type === "response.error") {
						const errMessage =
							((anyEv.response as { error?: { message?: string } } | undefined)?.error?.message) ??
							((ev as { error?: { message?: string } }).error?.message) ??
							"Codex Responses API stream failed";
						throw new Error(errMessage);
					}
				}
			} catch (err) {
				recordQuotaCap(err, runtime);
				throw err;
			}
			if (images.length === 0) {
				throw new Error("plugin-codex-chatgpt: no image_generation_call output returned");
			}
			return images;
		},

		// Image description / vision — Codex models accept image inputs via
		// input_image content blocks. Codex Responses API REQUIRES stream:true
		// (returns "Stream must be set to true" 400 for non-streaming), so we
		// accumulate text-delta events and parse JSON at the end.
		[ModelType.IMAGE_DESCRIPTION]: async (
			runtime: IAgentRuntime,
			params: ImageDescriptionParams | string,
		): Promise<{ title: string; description: string }> => {
			const client = buildClient(runtime);
			const model = pickModel(runtime, "CODEX_MODEL_LARGE", "gpt-5.2");
			const url = typeof params === "string" ? params : params.imageUrl;
			const prompt =
				typeof params === "string"
					? "Describe this image. Respond as JSON: {\"title\": string, \"description\": string}"
					: params.prompt ?? "Describe this image. Respond as JSON: {\"title\": string, \"description\": string}";
			const req: CreateResponseRequest = {
				model,
				input: [
					{
						type: "message",
						role: "user",
						content: [
							{ type: "input_text", text: prompt },
							{ type: "input_image", image_url: url, detail: "auto" },
						],
					},
				],
				instructions: "You are a helpful vision assistant. Analyze the image and respond as requested.",
				stream: true,
				store: false,
			};
			let collected = "";
			try {
				for await (const ev of client.stream(req)) {
					if (ev.type === "response.output_text.delta") {
						collected += (ev as { delta?: string }).delta ?? "";
					} else if (ev.type === "response.failed" || ev.type === "response.error") {
						const errMessage =
							(ev as { response?: { error?: { message?: string } }; error?: { message?: string } }).response?.error?.message ??
							(ev as { error?: { message?: string } }).error?.message ??
							"Codex Responses API stream failed";
						throw new Error(errMessage);
					}
				}
			} catch (err) {
				recordQuotaCap(err, runtime);
				throw err;
			}
			try {
				const fenced = collected.match(/```(?:json)?\s*([\s\S]+?)```/);
				const parsed = JSON.parse(fenced ? fenced[1]! : collected) as { title?: string; description?: string };
				return { title: parsed.title ?? "Image", description: parsed.description ?? collected };
			} catch {
				return { title: "Image", description: collected };
			}
		},

		// Embeddings: ChatGPT subscription doesn't expose embeddings, so we
		// don't register a TEXT_EMBEDDING handler here. The runtime falls
		// through to whichever plugin owns embeddings (embedding-stub or a
		// real provider). Registering a handler here would mask better
		// providers since we'd just return zeros.
	},
};

function extractOutputText(response: Record<string, unknown>): string {
	const outputs = (response.output as Array<Record<string, unknown>> | undefined) ?? [];
	const parts: string[] = [];
	for (const item of outputs) {
		if (item.type === "message") {
			const content = (item.content as Array<{ type?: string; text?: string }> | undefined) ?? [];
			for (const c of content) {
				if (c.type === "output_text" && typeof c.text === "string") parts.push(c.text);
			}
		}
	}
	const joined = parts.join("");
	if (joined) return joined;
	const flat = (response.output_text as string | undefined) ?? "";
	return flat;
}

export default codexChatGptPlugin;
export { CodexResponsesClient } from "./responses-client";
export { decodeCodexJwt } from "./jwt";
