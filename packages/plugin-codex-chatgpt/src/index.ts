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
	logger,
	ModelType,
	type GenerateTextParams,
	type IAgentRuntime,
	type ImageDescriptionParams,
	type ObjectGenerationParams,
	type Plugin,
	type TextEmbeddingParams,
} from "@elizaos/core";
import {
	CodexResponsesClient,
	type CreateResponseRequest,
	type ResponsesInputItem,
	type ResponsesContentItem,
} from "./responses-client";

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

function pickModel(runtime: IAgentRuntime, key: string, fallback: string): string {
	return getSetting(runtime, key, fallback) ?? fallback;
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
		...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
		...(params.maxTokens !== undefined ? { max_output_tokens: params.maxTokens } : {}),
	};

	let collected = "";
	for await (const ev of client.stream(req)) {
		if (ev.type === "response.output_text.delta") {
			const delta = (ev as { delta?: string }).delta ?? "";
			collected += delta;
		} else if (ev.type === "response.failed" || ev.type === "response.error") {
			const errMessage =
				(ev as { response?: { error?: { message?: string } }; error?: { message?: string } }).response?.error?.message ??
				(ev as { error?: { message?: string } }).error?.message ??
				"Codex Responses API error";
			throw new Error(errMessage);
		}
	}
	return collected;
}

export const codexChatGptPlugin: Plugin = {
	name: "codex-chatgpt",
	description: "OpenAI Codex via ChatGPT subscription OAuth (chatgpt.com/backend-api/codex/responses)",

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
		// Returns base64-encoded PNG payloads.
		[ModelType.IMAGE]: async (
			runtime: IAgentRuntime,
			params: { prompt: string; n?: number; size?: string; quality?: "low" | "medium" | "high" | "auto" },
		): Promise<Array<{ url: string; revisedPrompt?: string }>> => {
			const client = buildClient(runtime);
			const model = pickModel(runtime, "CODEX_MODEL_IMAGE", "gpt-5.2");
			const req: CreateResponseRequest = {
				model,
				input: [{ type: "message", role: "user", content: [{ type: "input_text", text: params.prompt }] }],
				tools: [
					{
						type: "image_generation",
						quality: params.quality ?? "auto",
						...(params.size ? { size: params.size } : {}),
					},
				],
				instructions: "You are an image generation assistant. Generate an image matching the user's request.",
				stream: false,
				store: false,
			};
			const out = await client.create(req);
			const outputs = (out.output as Array<Record<string, unknown>> | undefined) ?? [];
			const images: Array<{ url: string; revisedPrompt?: string }> = [];
			for (const item of outputs) {
				if (item.type === "image_generation_call" && typeof item.result === "string") {
					// Codex returns base64-encoded PNG. Wrap as data URL so it
					// satisfies the ImageGenerationResult.url contract without
					// requiring an upload step.
					const url = `data:image/png;base64,${item.result as string}`;
					const entry: { url: string; revisedPrompt?: string } = { url };
					if (typeof item.revised_prompt === "string") entry.revisedPrompt = item.revised_prompt as string;
					images.push(entry);
				}
			}
			if (images.length === 0) {
				throw new Error("plugin-codex-chatgpt: no image_generation_call output returned");
			}
			return images;
		},

		// Image description / vision — Codex models accept image inputs via
		// input_image content blocks. Caller passes a URL or base64 data URI.
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
				stream: false,
				store: false,
			};
			const out = await client.create(req);
			const text = extractOutputText(out);
			try {
				const fenced = text.match(/```(?:json)?\s*([\s\S]+?)```/);
				const parsed = JSON.parse(fenced ? fenced[1]! : text) as { title?: string; description?: string };
				return { title: parsed.title ?? "Image", description: parsed.description ?? text };
			} catch {
				return { title: "Image", description: text };
			}
		},

		// Embeddings — Codex/ChatGPT subscription does NOT expose embeddings
		// through this endpoint. Return zero vector so the runtime doesn't
		// blow up; consumers needing real embeddings should configure a
		// dedicated provider (plugin-openai with API key, local Llama).
		[ModelType.TEXT_EMBEDDING]: async (
			_runtime: IAgentRuntime,
			_params: TextEmbeddingParams | string | null,
		): Promise<number[]> => {
			logger.warn(
				"[codex-chatgpt] TEXT_EMBEDDING called but ChatGPT subscription doesn't expose embeddings — returning zero vector. Configure a real embeddings provider for memory/RAG.",
			);
			return new Array(1536).fill(0);
		},
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
