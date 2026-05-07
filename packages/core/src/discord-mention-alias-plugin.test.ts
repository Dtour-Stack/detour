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
import { installDiscordMentionAliasPatch, installDiscordMessageManagerGuard } from "./discord-mention-alias-plugin";

type HandleMessage = (
	runtime: IAgentRuntime,
	message: Memory,
	callback?: HandlerCallback,
	options?: MessageProcessingOptions,
) => Promise<MessageProcessingResult>;

const INTERNAL_FALLBACK_TERMS = ["pipeline", "tripped", "fallback", "provider", "llm", "runtime", "generation"];

function expectPublicDiscordText(text: unknown): asserts text is string {
	expect(typeof text).toBe("string");
	const value = String(text);
	expect(value.length).toBeGreaterThan(0);
	const lower = value.toLowerCase();
	for (const term of INTERNAL_FALLBACK_TERMS) {
		expect(lower.includes(term)).toBe(false);
	}
}

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

function metadataOnlyDiscordMessage(): Memory {
	return {
		id: "message-id",
		roomId: "room-id",
		entityId: "user-id",
		content: {
			text: "Detour hello",
			mentionContext: { isMention: true },
		},
		metadata: {
			source: "discord",
			trajectoryId: "trajectory-id",
			trajectoryStepId: "step-id",
		},
	} as never;
}

function makeRuntime(
	handleMessage: HandleMessage,
	useModel: () => Promise<string | null> = async () => "fallback reply",
) {
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
		useModel,
		logger: { warn: () => undefined },
	} as never;
	const callback: HandlerCallback = async (content) => {
		replies.push(content);
		return [{ id: "reply-id", content }] as never;
	};
	installDiscordMentionAliasPatch(runtime);
	return { runtime, service, callback, replies, llmCalls, steps };
}

function makeManagerRuntime(useModel: () => Promise<string | null> = async () => "manager fallback") {
	const sent: unknown[] = [];
	const events: unknown[] = [];
	const messageManager: { handleMessage: (message: unknown) => Promise<unknown> } = {
		handleMessage: async () => undefined,
	};
	const runtime: IAgentRuntime = {
		agentId: "agent-id",
		character: { name: "Detour Squirrel", username: "detour_squirrel" },
		getSetting: (key: string) => {
			if (key === "DISCORD_ADDRESSED_REPLY_GUARD_MS") return "5";
			if (key === "DISCORD_FALLBACK_GENERATION_MS") return "100";
			return undefined;
		},
		getService: (type: string) => type === "discord"
			? {
					client: { user: { id: "bot-id", username: "Detour" } },
					messageManager,
				}
			: null,
		getServicesByType: () => [],
		useModel,
		emitEvent: async (_event: unknown, payload: unknown) => {
			events.push(payload);
		},
		logger: { warn: () => undefined },
	} as never;
	const message = {
		id: "discord-message-id",
		content: "Detour hello",
		createdTimestamp: Date.now(),
		author: { id: "user-id", bot: false },
		mentions: { users: { has: (id: string) => id === "bot-id" } },
		channel: {
			id: "channel-id",
			messages: { fetch: async () => ({ values: () => [][Symbol.iterator]() }) },
		},
		reply: async (payload: unknown) => {
			sent.push(payload);
		},
	};
	installDiscordMessageManagerGuard(runtime);
	return { runtime, messageManager, message, sent, events };
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

	test("last-resort fallback text does not leak internal pipeline wording", async () => {
		const { runtime, service, callback, replies } = makeRuntime(
			async () => await new Promise<MessageProcessingResult>(() => undefined),
			async () => {
				throw new Error("model unavailable");
			},
		);

		const result = await service.handleMessage(runtime, discordMessage(), callback);

		expect(result.didRespond).toBe(true);
		expectPublicDiscordText(result.responseContent?.text);
		expect(result.responseContent.text).not.toBe("I saw it. Reply pipeline tripped, but I am still here.");
		expect(replies.map((reply) => reply.text)).toEqual([result.responseContent.text]);
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

	test("Discord metadata is enough when content.source is missing", async () => {
		const { runtime, service, callback, replies } = makeRuntime(
			async () => ({
				didRespond: false,
				responseContent: null,
				responseMessages: [],
				mode: "none",
			}),
		);

		const result = await service.handleMessage(runtime, metadataOnlyDiscordMessage(), callback);

		expect(result.didRespond).toBe(true);
		expect(replies.map((reply) => reply.text)).toEqual(["fallback reply"]);
	});

	test("raw Discord manager guard sends when addressed handling returns silent", async () => {
		const { messageManager, message, sent, events } = makeManagerRuntime();

		await messageManager.handleMessage(message);

		expect(sent).toHaveLength(1);
		expect(sent[0]).toEqual({
			content: "manager fallback",
			allowedMentions: { repliedUser: false },
		});
		expect(events).toHaveLength(1);
	});

	test("raw Discord manager guard hides internal wording when generation fails", async () => {
		const { messageManager, message, sent } = makeManagerRuntime(async () => {
			throw new Error("model unavailable");
		});

		await messageManager.handleMessage(message);

		expect(sent).toHaveLength(1);
		const payload = sent[0] as { content?: unknown };
		expectPublicDiscordText(payload.content);
		expect(payload.content).not.toBe("I saw it. Reply pipeline tripped, but I am still here.");
	});
});
