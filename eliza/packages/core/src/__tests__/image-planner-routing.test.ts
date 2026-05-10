import { describe, expect, it } from "vitest";
import { generateImageAction } from "../features/advanced-capabilities/actions/imageGeneration.ts";
import { actionsProvider } from "../features/basic-capabilities/providers/actions.ts";
import {
	looksLikeExplicitImageGenerationRequest,
	suggestOwnedActionFromMetadata,
	withInferredContextRoutingFallback,
} from "../services/message.ts";
import type { Action, IAgentRuntime, Memory, UUID } from "../types";
import { ModelType } from "../types/model.ts";
import { setContextRoutingMetadata } from "../utils/context-routing.ts";

const AGENT_ID = "11111111-1111-1111-1111-111111111111" as UUID;
const ENTITY_ID = "22222222-2222-2222-2222-222222222222" as UUID;
const ROOM_ID = "33333333-3333-3333-3333-333333333333" as UUID;

function message(text: string): Memory {
	return {
		id: "44444444-4444-4444-4444-444444444444" as UUID,
		agentId: AGENT_ID,
		entityId: ENTITY_ID,
		roomId: ROOM_ID,
		createdAt: Date.now(),
		content: { text, source: "discord" },
	};
}

function action(
	name: string,
	description: string,
	similes: string[] = [],
): Action {
	return {
		name,
		description,
		similes,
		validate: async () => true,
		handler: async () => ({ success: true }),
	};
}

describe("image planner routing", () => {
	it("detects explicit image generation requests", () => {
		expect(
			looksLikeExplicitImageGenerationRequest(
				"generate me a caricature image of the people in this channel",
			),
		).toBe(true);
		expect(
			looksLikeExplicitImageGenerationRequest(
				"can you make a Cozy Devs poster",
			),
		).toBe(true);
		expect(looksLikeExplicitImageGenerationRequest("what do you think?")).toBe(
			false,
		);
	});

	it("suggests GENERATE_IMAGE as the owning action", () => {
		const suggestion = suggestOwnedActionFromMetadata(
			{
				actions: [
					action("REPLY", "Send a direct reply"),
					action("GENERATE_IMAGE", "Generate an image from a prompt", [
						"CREATE_IMAGE",
						"MAKE_IMAGE",
					]),
				],
			},
			message("draw a banner image for the Cozy Devs update"),
		);

		expect(suggestion?.actionName).toBe("GENERATE_IMAGE");
	});

	it("keeps media actions visible when classifier picked a social channel", async () => {
		const msg = message(
			"generate me a caricature image of the people in this channel",
		);
		setContextRoutingMetadata(
			msg,
			withInferredContextRoutingFallback({ primaryContext: "social" }, msg),
		);

		const result = await actionsProvider.get(
			{
				agentId: AGENT_ID,
				actions: [
					action("REPLY", "Send a direct reply"),
					action("GENERATE_IMAGE", "Generate an image from a prompt"),
				],
				providers: [],
			} as IAgentRuntime,
			msg,
			{ values: {}, data: {}, text: "" },
		);

		const names = result.data.actionsData.map((item) => item.name);
		expect(names).toContain("GENERATE_IMAGE");
	});

	it("keeps image generation visible in social-only channel routing", async () => {
		const msg = message(
			"@Detour generate me a caricature image of the people in this channel in one big Cozy Dev group image",
		);
		setContextRoutingMetadata(msg, { primaryContext: "social" });

		const result = await actionsProvider.get(
			{
				agentId: AGENT_ID,
				actions: [
					action("REPLY", "Send a direct reply"),
					action("GENERATE_IMAGE", "Generate an image from a prompt"),
				],
				providers: [],
			} as IAgentRuntime,
			msg,
			{ values: {}, data: {}, text: "" },
		);

		const names = result.data.actionsData.map((item) => item.name);
		expect(names).toContain("GENERATE_IMAGE");
	});

	it("builds group image prompts with Discord people context", async () => {
		const msg = message(
			"@Detour generate me a caricature image of the people in this channel, and your assumptions about them in one big Cozy Dev group image",
		);
		let composedProviders: string[] = [];
		let promptForTextModel = "";

		const runtime = {
			agentId: AGENT_ID,
			character: { name: "Detour" },
			composeState: async (_message: Memory, providers: string[]) => {
				composedProviders = providers;
				return {
					values: {
						recentMessages:
							"dEXploarer is intense and technical. fishai jokes around. botdick is a recurring dev nickname.",
						discordContext:
							"Known Discord people: dEXploarer, fishai, botdick. Use this as factual room context.",
					},
					data: {},
					text: "Known Discord people: dEXploarer, fishai, botdick. Use this as factual room context.",
				};
			},
			useModel: async (modelType: string, params: { prompt?: string }) => {
				if (modelType === ModelType.TEXT_LARGE) {
					promptForTextModel = params.prompt ?? "";
					return "thought: build a room-aware caricature prompt\nprompt: A big Cozy Dev group caricature with dEXploarer, fishai, and botdick as stylized developer characters";
				}
				if (modelType === ModelType.IMAGE) {
					return [{ url: "https://example.com/cozy-devs.png" }];
				}
				throw new Error(`unexpected model type: ${modelType}`);
			},
			logger: {
				info: () => undefined,
				error: () => undefined,
			},
		};

		const result = await generateImageAction.handler(
			runtime as unknown as IAgentRuntime,
			msg,
			undefined,
			{
				parameters: {
					prompt:
						"generate a caricature image of the people in this channel as one big Cozy Dev group image",
				},
			},
			async () => [],
		);

		expect(result.success).toBe(true);
		expect(composedProviders).toContain("RECENT_MESSAGES");
		expect(composedProviders).toContain("DISCORD_CONTEXT");
		expect(composedProviders).toContain("ENTITIES");
		expect(promptForTextModel).toContain("User image request");
		expect(promptForTextModel).toContain("Cozy Dev group image");
		expect(promptForTextModel).toContain("Known Discord people");
	});
});
