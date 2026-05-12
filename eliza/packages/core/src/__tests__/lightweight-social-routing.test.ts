import { describe, expect, it } from "vitest";
import {
	looksLikeLightweightSocialTurn,
	looksLikeNonActionableChatter,
} from "../features/basic-capabilities/providers/non-actionable-chatter.ts";
import {
	DefaultMessageService,
	shouldAttemptActionRescue,
} from "../services/message.ts";
import { ChannelType, ModelType } from "../types";
import type { Action, IAgentRuntime, Memory, State, UUID } from "../types";

const AGENT_ID = "11111111-1111-1111-1111-111111111111" as UUID;
const ENTITY_ID = "22222222-2222-2222-2222-222222222222" as UUID;
const ROOM_ID = "33333333-3333-3333-3333-333333333333" as UUID;
const RUN_ID = "55555555-5555-5555-5555-555555555555" as UUID;

function message(text: string): Memory {
	return {
		id: "44444444-4444-4444-4444-444444444444" as UUID,
		agentId: AGENT_ID,
		entityId: ENTITY_ID,
		roomId: ROOM_ID,
		createdAt: Date.now(),
		content: { text, source: "tray-app" },
	};
}

function action(name: string): Action {
	return {
		name,
		description: `${name} action`,
		validate: async () => true,
		handler: async () => ({ success: true }),
	};
}

describe("lightweight social routing", () => {
	it("recognizes exact low-information social turns", () => {
		expect(looksLikeLightweightSocialTurn(message("hey"))).toBe(true);
		expect(looksLikeLightweightSocialTurn(message("thanks!"))).toBe(true);
		expect(looksLikeLightweightSocialTurn(message("hey can you open GitHub"))).toBe(
			false,
		);
		expect(looksLikeLightweightSocialTurn(message("thanks, save that"))).toBe(
			false,
		);
	});

	it("treats lightweight social turns as non-actionable chatter", () => {
		expect(looksLikeNonActionableChatter(message("hello"))).toBe(true);
		expect(looksLikeNonActionableChatter(message("open the browser"))).toBe(
			false,
		);
	});

	it("does not rescue an explicit conversational reply into a tool action", () => {
		const shouldRescue = shouldAttemptActionRescue(
			{ actions: [action("REPLY"), action("OPEN_BROWSER")] },
			message("hey"),
			{
				values: { actionNames: "Possible response actions: REPLY, OPEN_BROWSER" },
				data: {},
				text: "",
			},
			{
				actions: ["REPLY"],
				text: "hey, I'm here",
				providers: [],
			},
		);

		expect(shouldRescue).toBe(false);
	});

	it("still rescues passive drafts for actionable requests", () => {
		const shouldRescue = shouldAttemptActionRescue(
			{ actions: [action("OPEN_BROWSER")] },
			message("open the browser"),
			{
				values: { actionNames: "Possible response actions: OPEN_BROWSER" },
				data: {},
				text: "",
			},
			{
				actions: ["NONE"],
				text: "I can help with that.",
				providers: [],
			},
		);

		expect(shouldRescue).toBe(true);
	});

	it("answers non-actionable relationship chat without action/provider state", async () => {
		const service = new DefaultMessageService();
		const providerLists: string[][] = [];
		const modelTypes: string[] = [];
		const callbackTexts: string[] = [];
		const runtime = {
			agentId: AGENT_ID,
			character: {
				name: "Detour",
				username: "detour",
				settings: {},
			},
			logger: {
				debug: () => undefined,
				info: () => undefined,
				warn: () => undefined,
				error: () => undefined,
			},
			getSetting: () => undefined,
			emitEvent: async () => undefined,
			startRun: () => RUN_ID,
			getCurrentRunId: () => RUN_ID,
			stateCache: {
				delete: () => true,
			},
			getMemoryById: async () => null,
			createMemory: async (memory: Memory) => memory.id ?? RUN_ID,
			queueEmbeddingGeneration: async () => undefined,
			getParticipantUserState: async () => null,
			getRoom: async () => ({ id: ROOM_ID, type: ChannelType.DM }),
			applyPipelineHooks: async () => undefined,
			isCheckShouldRespondEnabled: () => true,
			composeState: async (
				_message: Memory,
				includeList: string[] | null,
			): Promise<State> => {
				providerLists.push(includeList ?? []);
				return {
					values: {
						agentName: "Detour",
						providers: [
							"# Character",
							"Detour knows this user across chat surfaces.",
							"# Recent Messages",
							"User has been venting about inbox overload.",
						].join("\n"),
						recentMessages: "User has been venting about inbox overload.",
					},
					data: {},
					text: "User has been venting about inbox overload.",
				};
			},
			getModel: (modelType: string) =>
				modelType === ModelType.TEXT_SMALL ? (() => undefined) : undefined,
			useModel: async (modelType: string) => {
				modelTypes.push(modelType);
				return "That sounds draining. I am here with you.";
			},
		} as IAgentRuntime;

		const result = await service.handleMessage(
			runtime,
			message("i hate email"),
			async (content) => {
				if (typeof content?.text === "string" && content.text.length > 0) {
					callbackTexts.push(content.text);
				}
				return [];
			},
		);

		expect(result.reason).toBe("conversation-only-turn");
		expect(result.mode).toBe("simple");
		expect(modelTypes).toEqual([ModelType.TEXT_SMALL]);
		expect(providerLists).toEqual([
			["ENTITIES", "CHARACTER", "RECENT_MESSAGES"],
		]);
		expect(callbackTexts).toEqual(["That sounds draining. I am here with you."]);
	});
});
