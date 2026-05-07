import { describe, expect, test } from "bun:test";
import type {
	Content,
	HandlerCallback,
	IAgentRuntime,
	IMessageService,
	Memory,
	MessageProcessingOptions,
	MessageProcessingResult,
} from "@elizaos/core";
import { installDiscordMentionAliasPatch } from "./discord-mention-alias-plugin";

type HandleMessage = (
	runtime: IAgentRuntime,
	message: Memory,
	callback?: HandlerCallback,
	options?: MessageProcessingOptions,
) => Promise<MessageProcessingResult>;

function discordMessage(): Memory {
	return {
		id: "message-id",
		roomId: "room-id",
		entityId: "user-id",
		content: { source: "discord", text: "@Detour hello" },
		metadata: {
			trajectoryId: "trajectory-id",
			trajectoryStepId: "step-id",
		},
	} as never;
}

function makeRuntime(handleMessage: HandleMessage) {
	const replies: Content[] = [];
	const llmCalls: unknown[] = [];
	const steps: unknown[] = [];
	const service = { handleMessage } as IMessageService;
	const trajectoryLogger = {
		logLlmCall: (params: unknown) => {
			llmCalls.push(params);
		},
		completeStep: (...args: unknown[]) => {
			steps.push(args);
		},
	};
	const runtime: IAgentRuntime = {
		character: { name: "Detour Squirrel", username: "detour_squirrel" },
		messageService: service,
		getSetting: (key: string) => {
			if (key === "DISCORD_ADDRESSED_REPLY_GUARD_MS") return "5";
			if (key === "DISCORD_FALLBACK_GENERATION_MS") return "100";
			return undefined;
		},
		getService: (type: string) => type === "trajectories" ? trajectoryLogger : null,
		getServicesByType: () => [],
		useModel: async () => "fallback reply",
		logger: { warn: () => undefined },
	} as never;
	const callback: HandlerCallback = async (content) => {
		replies.push(content);
		return [{ id: "reply-id", content }] as never;
	};
	installDiscordMentionAliasPatch(runtime);
	return { runtime, service, callback, replies, llmCalls, steps };
}

describe("discord mention alias reply guard", () => {
	test("addressed Discord messages fall back when the normal handler hangs", async () => {
		const { runtime, service, callback, replies, llmCalls, steps } = makeRuntime(
			async () => await new Promise<MessageProcessingResult>(() => undefined),
		);

		const result = await service.handleMessage(runtime, discordMessage(), callback);

		expect(result.didRespond).toBe(true);
		expect(result.responseContent?.text).toBe("fallback reply");
		expect(replies.map((reply) => reply.text)).toEqual(["fallback reply"]);
		expect(llmCalls).toHaveLength(1);
		expect(steps).toHaveLength(1);
	});

	test("late handler callbacks are suppressed after fallback sends", async () => {
		let release: () => void = () => undefined;
		const { runtime, service, callback, replies } = makeRuntime(
			async (_runtime, _message, originalCallback) => {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				await originalCallback?.({ text: "late original reply" });
				return {
					didRespond: true,
					responseContent: { text: "late original reply" },
					responseMessages: [],
					mode: "simple",
				};
			},
		);

		await service.handleMessage(runtime, discordMessage(), callback);
		release();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(replies.map((reply) => reply.text)).toEqual(["fallback reply"]);
	});
});
