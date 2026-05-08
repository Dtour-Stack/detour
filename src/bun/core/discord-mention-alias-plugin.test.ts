import { describe, expect, test } from "bun:test";
import type {
	Action,
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

type TestUseModel = (modelType: unknown, params: unknown) => Promise<string | null>;
type ManagerRuntimeOptions = {
	useModel?: TestUseModel;
	actions?: Action[];
	history?: Array<{
		id: string;
		content: string;
		createdTimestamp: number;
		author: { id: string; username?: string; displayName?: string; globalName?: string; bot?: boolean };
	}>;
	message?: {
		id?: string;
		content?: string;
		createdTimestamp?: number;
	};
};

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
	useModel: TestUseModel = async () => "fallback reply",
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

function makeManagerRuntime(options: ManagerRuntimeOptions = {}) {
	const useModel = options.useModel ?? (async () => "manager fallback");
	const sent: unknown[] = [];
	const events: unknown[] = [];
	const messageManager: { handleMessage: (message: unknown) => Promise<unknown> } = {
		handleMessage: async () => undefined,
	};
	const runtime: IAgentRuntime = {
		agentId: "agent-id",
		character: { name: "Detour Squirrel", username: "detour_squirrel" },
		actions: options.actions ?? [],
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
		id: options.message?.id ?? "discord-message-id",
		content: options.message?.content ?? "Detour hello",
		createdTimestamp: options.message?.createdTimestamp ?? Date.now(),
		author: { id: "user-id", bot: false },
		mentions: { users: { has: (id: string) => id === "bot-id" } },
		channel: {
			id: "channel-id",
			messages: { fetch: async () => ({ values: () => (options.history ?? [])[Symbol.iterator]() }) },
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

	test("reply guard does not send hardcoded public filler when generation fails", async () => {
		const { runtime, service, callback, replies } = makeRuntime(
			async () => await new Promise<MessageProcessingResult>(() => undefined),
			async () => {
				throw new Error("model unavailable");
			},
		);

		const result = await service.handleMessage(runtime, discordMessage(), callback);

		expect(result.didRespond).toBe(false);
		expect(result.responseContent).toBeNull();
		expect(replies).toEqual([]);
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

	test("raw Discord manager guard suppresses public filler when generation fails", async () => {
		const { messageManager, message, sent } = makeManagerRuntime({
			useModel: async () => {
				throw new Error("model unavailable");
			},
		});

		await messageManager.handleMessage(message);

		expect(sent).toEqual([]);
	});

	test("raw Discord manager guard gives generated replies recent channel context", async () => {
		const prompts: string[] = [];
		const { messageManager, message, sent } = makeManagerRuntime({
			message: {
				id: "current",
				content: "Detour i was specifically asking about in your notifications",
				createdTimestamp: 3,
			},
			history: [
				{
					id: "previous",
					content: "Detour any fud on X lately?",
					createdTimestamp: 1,
					author: { id: "user-id", username: "Dexploarer" },
				},
				{
					id: "bot-reply",
					content: "Always. Send me the post and I will sniff-test it.",
					createdTimestamp: 2,
					author: { id: "bot-id", username: "Detour", bot: true },
				},
				{
					id: "current",
					content: "Detour i was specifically asking about in your notifications",
					createdTimestamp: 3,
					author: { id: "user-id", username: "Dexploarer" },
				},
			],
			useModel: async (_modelType, params) => {
				const prompt = (params as { prompt?: string }).prompt ?? "";
				prompts.push(prompt);
				return "checking notifications";
			},
		});

		await messageManager.handleMessage(message);

		expect(sent).toHaveLength(1);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("Detour any fud on X lately?");
		expect(prompts[0]).toContain("Always. Send me the post");
		expect(prompts[0]).toContain("specifically asking about in your notifications");
	});

	test("raw Discord manager guard includes X notifications for notification questions", async () => {
		const prompts: string[] = [];
		const xNotificationsAction: Action = {
			name: "X_NOTIFICATIONS",
			description: "Read recent X notifications",
			validate: async () => true,
			handler: async (_runtime, _message, _state, _options, callback) => {
				await callback?.({
					text: "10 notifications:\n• [reply] @fishai asked if there is fud in the replies (tweet 205)",
				}, "X_NOTIFICATIONS");
				return { success: true };
			},
		};
		const { messageManager, message, sent } = makeManagerRuntime({
			actions: [xNotificationsAction],
			message: {
				id: "current",
				content: "Detour any fud on X lately?",
				createdTimestamp: 1,
			},
			useModel: async (_modelType, params) => {
				const prompt = (params as { prompt?: string }).prompt ?? "";
				prompts.push(prompt);
				return "yeah, fishai is poking at the replies. nothing fatal, just normal X noise.";
			},
		});

		await messageManager.handleMessage(message);

		expect(sent).toHaveLength(1);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("X notification context");
		expect(prompts[0]).toContain("@fishai");
	});
});
