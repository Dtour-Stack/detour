import { describe, expect, test } from "bun:test";
import { ModelType, type IAgentRuntime } from "@elizaos/core";
import {
	installDpeFallbackPatch,
	runWithPlannerFallbackContext,
	setCompanionPlannerHook,
	conversationText,
} from "./dpe-fallback-plugin";
import { getProviderQuotaService } from "./provider-quota-service";

type DynamicPromptArgs = Parameters<IAgentRuntime["dynamicPromptExecFromState"]>[0];

const plannerSchema: DynamicPromptArgs["schema"] = [
	{ field: "thought", description: "Planner thought" },
	{ field: "actions", description: "Selected actions" },
	{ field: "providers", description: "Provider context" },
	{ field: "text", description: "Reply text" },
	{ field: "simple", description: "Simple response flag" },
];

const plannerArgs = {
	params: { prompt: "Reply to the user." },
	options: { modelType: ModelType.ACTION_PLANNER },
	schema: plannerSchema,
	state: {
		values: { recentMessages: "user: Detour hello" },
		data: {},
		text: "Detour hello",
	},
} satisfies DynamicPromptArgs;

function makeRuntime(
	original: (args?: unknown) => Promise<unknown>,
	useModel: (modelType: unknown, params: unknown) => Promise<string> = async () => "plain reply",
	character: Record<string, unknown> = { name: "Detour Squirrel" },
	settings: Record<string, string> = {},
): { runtime: IAgentRuntime; calls: string[] } {
	const calls: string[] = [];
	const runtime = {
		character,
		getSetting: (key: string) => settings[key],
		dynamicPromptExecFromState: async (args: unknown) => {
			calls.push("original");
			return await original(args);
		},
		useModel: async (modelType: unknown, params: unknown) => {
			calls.push("model");
			return await useModel(modelType, params);
		},
		logger: { warn: () => undefined },
	} as never;
	installDpeFallbackPatch(runtime);
	return { runtime, calls };
}

describe("dpe fallback patch", () => {
	test("uses the normal planner before plain text fallback", async () => {
		const { runtime, calls } = makeRuntime(async () => ({
			thought: "normal planner",
			actions: ["REPLY"],
			providers: "",
			text: "normal reply",
			simple: true,
		}));

		const result = await runWithPlannerFallbackContext(
			{ source: "discord", addressed: true },
			() => runtime.dynamicPromptExecFromState(plannerArgs),
		);

		expect(calls).toEqual(["original"]);
		expect(result?.text).toBe("normal reply");
	});

	test("falls back only after the addressed Discord planner fails", async () => {
		const { runtime, calls } = makeRuntime(async () => {
			throw new Error("planner failed");
		});

		const result = await runWithPlannerFallbackContext(
			{ source: "discord", addressed: true },
			() => runtime.dynamicPromptExecFromState(plannerArgs),
		);

		expect(calls).toEqual(["original", "model"]);
		expect(result?.text).toBe("plain reply");
	});

	test("does not blindly retry unaddressed planner failures", async () => {
		const { runtime, calls } = makeRuntime(async () => {
			throw new Error("planner failed");
		});

		await expect(runWithPlannerFallbackContext(
			{ source: "discord", addressed: false },
			() => runtime.dynamicPromptExecFromState(plannerArgs),
		)).rejects.toThrow("planner failed");

		expect(calls).toEqual(["original"]);
	});

	test("does not force plain replies for unaddressed Discord messages", async () => {
		const { runtime, calls } = makeRuntime(async () => null);

		const result = await runWithPlannerFallbackContext(
			{ source: "discord", addressed: false },
			() => runtime.dynamicPromptExecFromState(plannerArgs),
		);

		expect(calls).toEqual(["original"]);
		expect(result).toBeNull();
	});

	test("plain text replies include character context", async () => {
		const prompts: string[] = [];
		const { runtime } = makeRuntime(
			async () => {
				throw new Error("planner failed");
			},
			async (_modelType, params) => {
				prompts.push((params as { prompt?: string }).prompt ?? "");
				return "plain reply";
			},
			{
				name: "Detour Squirrel",
				system: "Dexploarer is your dev; carry prior Discord context.",
				bio: ["protector of cozy devs"],
				style: { chat: ["answer like a sharp dev friend"] },
			},
		);

		await runWithPlannerFallbackContext(
			{ source: "discord", addressed: true },
			() => runtime.dynamicPromptExecFromState(plannerArgs),
		);

		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("Dexploarer is your dev");
		expect(prompts[0]).toContain("protector of cozy devs");
		expect(prompts[0]).toContain("answer like a sharp dev friend");
	});

	test("does not turn provider failure diagnostics into public replies", async () => {
		const { runtime } = makeRuntime(
			async () => {
				throw new Error("planner failed");
			},
			async () => "Reply generation failed inside my provider path. Logged discord_generation_failed: apiKey=set",
		);

		const result = await runWithPlannerFallbackContext(
			{ source: "discord", addressed: true },
			() => runtime.dynamicPromptExecFromState(plannerArgs),
		);

		expect(result).toBeNull();
	});

	test("falls back for addressed Telegram planner failure", async () => {
		const { runtime, calls } = makeRuntime(async () => {
			throw new Error("planner failed");
		});

		const result = await runWithPlannerFallbackContext(
			{ source: "telegram", addressed: true },
			() => runtime.dynamicPromptExecFromState(plannerArgs),
		);

		expect(calls).toEqual(["original", "model"]);
		expect(result?.text).toBe("plain reply");
	});

	test("does not force plain replies for unaddressed Telegram groups", async () => {
		const { runtime, calls } = makeRuntime(async () => null);

		const result = await runWithPlannerFallbackContext(
			{ source: "telegram", addressed: false },
			() => runtime.dynamicPromptExecFromState(plannerArgs),
		);

		expect(calls).toEqual(["original"]);
		expect(result).toBeNull();
	});

	test("plain text fallback carries always-on provider context from composed state", async () => {
		const prompts: string[] = [];
		const { runtime } = makeRuntime(
			async () => {
				throw new Error("planner failed");
			},
			async (_modelType, params) => {
				prompts.push((params as { prompt?: string }).prompt ?? "");
				return "memory-aware reply";
			},
			{ name: "Detour Squirrel" },
			{
				ADDITIONAL_RESPONSE_STATE_PROVIDERS:
					"AGENT_CHARACTER_ANCHOR,FACTS,USER_ACTIVITY_CONTEXT",
			},
		);

		const argsWithProviders = {
			options: { modelType: ModelType.ACTION_PLANNER },
			params: { prompt: "Reply to the user." },
			schema: plannerSchema,
			state: {
				values: { recentMessages: "user: hi" },
				text: "hi",
				data: {
					providers: {
						AGENT_CHARACTER_ANCHOR: {
							text: "Identity anchor — Detour Squirrel.\nCarry tone across providers.",
						},
						FACTS: {
							text: "Known facts:\n- The user prefers tabs over spaces.",
						},
						USER_ACTIVITY_CONTEXT: {
							text: "Recent observation: user just finished a coding sprint.",
						},
					},
				},
			},
		} satisfies DynamicPromptArgs;

		const result = await runWithPlannerFallbackContext(
			{ source: "discord", addressed: true },
			() => runtime.dynamicPromptExecFromState(argsWithProviders),
		);

		expect(result?.text).toBe("memory-aware reply");
		expect(prompts).toHaveLength(1);
		const fallbackPrompt = prompts[0] ?? "";
		expect(fallbackPrompt).toContain("Memory and capability context");
		expect(fallbackPrompt).toContain("Identity anchor — Detour Squirrel");
		expect(fallbackPrompt).toContain("tabs over spaces");
		expect(fallbackPrompt).toContain("coding sprint");
	});

	test("plain text fallback skips memory block when no providers are configured", async () => {
		const prompts: string[] = [];
		const { runtime } = makeRuntime(
			async () => {
				throw new Error("planner failed");
			},
			async (_modelType, params) => {
				prompts.push((params as { prompt?: string }).prompt ?? "");
				return "plain reply";
			},
		);

		await runWithPlannerFallbackContext(
			{ source: "discord", addressed: true },
			() => runtime.dynamicPromptExecFromState(plannerArgs),
		);

		expect(prompts).toHaveLength(1);
		expect(prompts[0]).not.toContain("Memory and capability context");
	});

	test("applies companion pre-pass for persona framing and compression", async () => {
		let prePassCalled = false;
		let compressCalled = false;
		setCompanionPlannerHook({
			personaPrePass: async (agentName, userText) => {
				prePassCalled = true;
				expect(agentName).toBe("Detour Squirrel");
				expect(userText).toBe("Detour hello");
				return "persona-frame-text";
			},
			compress: async (history, targetTokens) => {
				compressCalled = true;
				expect(history.length).toBeGreaterThan(4000);
				return "compressed-summary";
			},
		});

		const { runtime } = makeRuntime(
			async (args) => {
				const typedArgs = args as { state?: { values?: Record<string, unknown> } };
				expect(typedArgs.state?.values?.detourCompanionFrame).toBe("persona-frame-text");
				expect(typedArgs.state?.values?.recentMessages).toContain("compressed-summary");
				return { text: "processed" };
			},
			async () => "plain",
			{ name: "Detour Squirrel" }
		);

		const longPlannerArgs = {
			...plannerArgs,
			state: {
				values: {
					recentMessages: "User: Detour hello\n" + "x\n".repeat(2500),
				},
				data: {},
				text: "Detour hello",
			},
		} satisfies DynamicPromptArgs;

		await runWithPlannerFallbackContext(
			{ source: "discord", addressed: true },
			() => runtime.dynamicPromptExecFromState(longPlannerArgs)
		);

		expect(prePassCalled).toBe(true);
		expect(compressCalled).toBe(true);
		setCompanionPlannerHook(null);
	});

	test("short-circuits planner when quota is capped", async () => {
		const quotaService = getProviderQuotaService();
		quotaService.setActiveCredential("openai", "test-account");
		quotaService.mark({
			providerId: "openai",
			accountId: "test-account",
			accountLabel: "OpenAI Premium",
			kind: "plan_quota",
			planType: "weekly-developer",
			resetsAtMs: Date.now() + 100_000,
			upstreamMessage: "Exceeded rate limit for model gpt-4",
		});

		const { runtime } = makeRuntime(async () => {
			throw new Error("should not be called because of quota cap");
		});

		const result = await runWithPlannerFallbackContext(
			{ source: "discord", addressed: true },
			() => runtime.dynamicPromptExecFromState(plannerArgs)
		);

		expect(result?.text).toContain("heads up — my active model provider (OpenAI Premium) hit its weekly cap.");
		expect(result?.simple).toBe(true);

		quotaService.setActiveCredential(null, null);
		quotaService.clear("openai", "test-account");
	});
});
