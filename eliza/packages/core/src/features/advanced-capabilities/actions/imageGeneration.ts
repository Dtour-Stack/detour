import { v4 } from "uuid";
import { requireActionSpec } from "../../../generated/spec-helpers.ts";
import {
	collectKeywordTermMatches,
	getValidationKeywordTerms,
} from "../../../i18n/validation-keywords.ts";
import { logger } from "../../../logger.ts";
import { imageGenerationTemplate } from "../../../prompts.ts";
import type {
	Action,
	ActionExample,
	ActionParameters,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "../../../types/index.ts";
import { ContentType, ModelType } from "../../../types/index.ts";
import { composePromptFromState, parseToonKeyValue } from "../../../utils.ts";

// Get text content from centralized specs
const spec = requireActionSpec("GENERATE_IMAGE");
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
const IMAGE_STRONG_TERMS = getValidationKeywordTerms(
	"action.generateImage.strong",
	{
		includeAllLocales: true,
	},
);
const IMAGE_WEAK_TERMS = getValidationKeywordTerms(
	"action.generateImage.weak",
	{
		includeAllLocales: true,
	},
);
const IMAGE_CONTEXT_PROVIDERS = [
	"RECENT_MESSAGES",
	"ENTITIES",
	"RELATIONSHIPS",
	"DISCORD_CONTEXT",
	"PLATFORM_CHAT_CONTEXT",
	"PLATFORM_USER_CONTEXT",
	"KNOWLEDGE",
] as const;

const getFileExtension = (url: string): string => {
	const urlPath = new URL(url).pathname;
	const lastDot = urlPath.lastIndexOf(".");
	if (lastDot === -1 || lastDot === urlPath.length - 1) {
		return "png";
	}
	const extension = urlPath.slice(lastDot + 1).toLowerCase();
	return IMAGE_EXTENSIONS.has(extension) ? extension : "png";
};

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function promptFromParams(params: ActionParameters | undefined): string | null {
	const prompt = params?.prompt;
	return typeof prompt === "string" && prompt.trim().length > 0
		? prompt.trim()
		: null;
}

function promptFromResponseParams(
	responses: Memory[] | undefined,
): string | null {
	for (const response of responses ?? []) {
		const params = asRecord(response.content?.params);
		const direct = params?.prompt;
		if (typeof direct === "string" && direct.trim().length > 0) {
			return direct.trim();
		}

		for (const key of ["GENERATE_IMAGE", spec.name]) {
			const nested = asRecord(params?.[key]);
			const nestedPrompt = nested?.prompt;
			if (typeof nestedPrompt === "string" && nestedPrompt.trim().length > 0) {
				return nestedPrompt.trim();
			}
		}
	}
	return null;
}

function promptFromMessage(message: Memory): string {
	return (
		typeof message.content === "string"
			? message.content
			: (message.content?.text ?? "")
	).trim();
}

function imageRequestForPrompt(
	message: Memory,
	options: HandlerOptions | undefined,
	responses: Memory[] | undefined,
): string {
	return (
		promptFromParams(options?.parameters) ??
		promptFromResponseParams(responses) ??
		promptFromMessage(message)
	);
}

function providerNames(responses: Memory[] | undefined): string[] {
	const names = new Set<string>(IMAGE_CONTEXT_PROVIDERS);
	for (const response of responses ?? []) {
		for (const provider of response.content?.providers ?? []) {
			if (typeof provider === "string" && provider.trim().length > 0) {
				names.add(provider.trim());
			}
		}
	}
	return Array.from(names);
}

export const generateImageAction = {
	name: spec.name,
	similes: spec.similes ? [...spec.similes] : [],
	description: spec.description,
	contexts: ["media", "social", "general"],
	parameters: spec.parameters ? [...spec.parameters] : [],
	validate: async (_runtime: IAgentRuntime, message: Memory) => {
		const text =
			typeof message?.content === "string"
				? message.content
				: (message?.content?.text ?? "");
		if (!text) return false;
		if (collectKeywordTermMatches([text], IMAGE_STRONG_TERMS).size > 0) {
			return true;
		}
		return collectKeywordTermMatches([text], IMAGE_WEAK_TERMS).size > 0;
	},
	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		_options?: HandlerOptions,
		callback?: HandlerCallback,
		responses?: Memory[],
	): Promise<ActionResult> => {
		const imageRequest = imageRequestForPrompt(message, _options, responses);

		state = await runtime.composeState(message, providerNames(responses));
		const providerText =
			typeof state.values?.providers === "string"
				? state.values.providers
				: state.text;
		state = {
			...state,
			values: {
				...(state.values ?? {}),
				...(providerText ? { providers: providerText } : {}),
				imageRequest,
			},
		};

		const prompt = composePromptFromState({
			state,
			template:
				runtime.character.templates?.imageGenerationTemplate ||
				imageGenerationTemplate,
		});

		const promptResponse = await runtime.useModel(ModelType.TEXT_LARGE, {
			prompt,
			stopSequences: [],
		});

		const parsedToon = parseToonKeyValue(promptResponse);
		const promptValue = parsedToon?.prompt;

		const imagePrompt: string =
			typeof promptValue === "string"
				? promptValue
				: "Unable to generate descriptive prompt for image";

		const imageResponse = await runtime.useModel(ModelType.IMAGE, {
			prompt: imagePrompt,
		});
		const imageResults = Array.isArray(imageResponse)
			? imageResponse
			: typeof imageResponse === "string"
				? [imageResponse]
				: [];
		const firstImage = imageResults[0];
		const firstImageUrl =
			typeof firstImage === "string" ? firstImage : firstImage?.url;

		if (imageResults.length === 0 || !firstImageUrl) {
			logger.error(
				{
					src: "plugin:advanced-capabilities:action:image_generation",
					agentId: runtime.agentId,
					imagePrompt,
				},
				"Image generation failed - no valid response received",
			);
			return {
				text: "Image generation failed",
				values: {
					success: false,
					error: "IMAGE_GENERATION_FAILED",
					prompt: imagePrompt,
				},
				data: {
					actionName: "GENERATE_IMAGE",
					prompt: imagePrompt,
					rawResponse: imageResults.map((image) => ({
						url: typeof image === "string" ? image : image.url,
					})),
				},
				success: false,
			};
		}

		const imageUrl = firstImageUrl;

		logger.info(
			{
				src: "plugin:advanced-capabilities:action:image_generation",
				agentId: runtime.agentId,
				imageUrl,
			},
			"Received image URL",
		);

		const extension = getFileExtension(imageUrl);
		const timestamp = new Date()
			.toISOString()
			.replace(/[:.]/g, "-")
			.slice(0, 19);
		const fileName = `Generated_Image_${timestamp}.${extension}`;
		const attachmentId = v4();

		const responseContent = {
			attachments: [
				{
					id: attachmentId,
					url: imageUrl,
					title: fileName,
					contentType: ContentType.IMAGE,
				},
			],
			thought: `Generated an image based on: "${imagePrompt}"`,
			actions: ["GENERATE_IMAGE"],
			text: imagePrompt,
		};

		if (callback) {
			await callback(responseContent);
		}

		return {
			text: "Generated image",
			values: {
				success: true,
				imageGenerated: true,
				imageUrl,
				prompt: imagePrompt,
			},
			data: {
				actionName: "GENERATE_IMAGE",
				imageUrl,
				prompt: imagePrompt,
			},
			success: true,
		};
	},
	examples: (spec.examples ?? []) as ActionExample[][],
} as Action;
