import { describe, expect, test } from "bun:test";
import { ModelType, type IAgentRuntime } from "@elizaos/core";
import { installDpeFallbackPatch, runWithPlannerFallbackContext } from "./dpe-fallback-plugin";

const plannerArgs = {
	options: { modelType: ModelType.ACTION_PLANNER },
	schema: [
		{ field: "thought" },
		{ field: "actions" },
		{ field: "providers" },
		{ field: "text" },
		{ field: "simple" },
	],
	state: {
		values: { recentMessages: "user: Detour hello" },
		text: "Detour hello",
	},
} as never;

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

		expect(calls).toEqual(["original", "original", "model"]);
		expect(result?.text).toBe("plain reply");
	});

	test("preserves planner retries and tries compact structured recovery before plain fallback", async () => {
		const plannerOptions: unknown[] = [];
		const { runtime } = makeRuntime(async (args) => {
			plannerOptions.push((args as { options?: Record<string, unknown> }).options);
			return null;
		});

		await runWithPlannerFallbackContext(
			{ source: "discord", addressed: true },
			() => runtime.dynamicPromptExecFromState(plannerArgs),
		);

		expect(plannerOptions[0]).toEqual({ modelType: ModelType.ACTION_PLANNER });
		expect(plannerOptions[1]).toMatchObject({
			modelType: ModelType.ACTION_PLANNER,
			preferredEncapsulation: "json",
			forceFormat: "json",
			maxRetries: 0,
			contextCheckLevel: 0,
			checkpointCodes: false,
		});
	});

	test("recovers addressed planner actions with compact structured retry before plain fallback", async () => {
		const plannerOptions: unknown[] = [];
		const { runtime, calls } = makeRuntime(async (args) => {
			plannerOptions.push((args as { options?: Record<string, unknown> }).options);
			if (plannerOptions.length === 1) throw new Error("planner failed");
			return {
				thought: "compact planner recovered",
				actions: ["SEND_IMESSAGE"],
				providers: "",
				text: "sending it now",
				simple: false,
			};
		});

		const result = await runWithPlannerFallbackContext(
			{ source: "telegram", addressed: true },
			() => runtime.dynamicPromptExecFromState(plannerArgs),
		);

		expect(calls).toEqual(["original", "original"]);
		expect(result?.actions).toEqual(["SEND_IMESSAGE"]);
		expect(plannerOptions[1]).toMatchObject({
			forceFormat: "json",
			maxRetries: 0,
			contextCheckLevel: 0,
		});
	});

	test("tries configured provider recovery before plain fallback on transient planner failure", async () => {
		const plannerProviders: unknown[] = [];
		const args = {
			options: { modelType: ModelType.ACTION_PLANNER },
			schema: [
				{ field: "thought" },
				{ field: "actions" },
				{ field: "providers" },
				{ field: "text" },
				{ field: "simple" },
			],
			state: {
				values: { recentMessages: "user: Detour send the iMessage" },
				text: "Detour send the iMessage",
			},
		} as never;
		const { runtime, calls } = makeRuntime(
			async (input) => {
				const record = input as { options?: Record<string, unknown>; state?: { data?: Record<string, unknown> } };
				plannerProviders.push(record.options?.model ?? "active");
				if (record.options?.model === "openrouter") {
					return {
						thought: "provider recovered",
						actions: ["SEND_IMESSAGE"],
						providers: "",
						text: "sending it now",
						simple: false,
					};
				}
				record.state!.data = {
					structuredOutputFailure: {
						kind: "model_error",
						parseError: "Codex Responses API 503: upstream connection timeout",
						responsePreview: "",
					},
				};
				return null;
			},
			async () => "plain reply",
			{ name: "Detour Squirrel" },
			{ OPENROUTER_API_KEY: "sk-openrouter-test" },
		);

		const result = await runWithPlannerFallbackContext(
			{ source: "telegram", addressed: true },
			() => runtime.dynamicPromptExecFromState(args),
		);

		expect(calls).toEqual(["original", "original", "original"]);
		expect(plannerProviders).toEqual(["active", "active", "openrouter"]);
		expect(result?.actions).toEqual(["SEND_IMESSAGE"]);
	});

	test("tries provider recovery for non-reply structured response handlers", async () => {
		const seenProviders: unknown[] = [];
		const responseArgs = {
			options: { modelType: ModelType.TEXT_MEDIUM },
			schema: [
				{ field: "name" },
				{ field: "reasoning" },
				{ field: "action" },
			],
			state: {
				values: { recentMessages: "user: hey" },
				text: "hey",
			},
		} as never;
		const { runtime, calls } = makeRuntime(
			async (input) => {
				const record = input as { options?: Record<string, unknown>; state?: { data?: Record<string, unknown> } };
				seenProviders.push(record.options?.model ?? "active");
				if (record.options?.model === "openrouter") {
					return { name: "reply", reasoning: "provider recovered", action: "REPLY" };
				}
				record.state!.data = {
					structuredOutputFailure: {
						kind: "model_error",
						parseError: "Insufficient credits",
						responsePreview: "",
					},
				};
				throw new Error("Insufficient credits");
			},
			async () => "plain reply",
			{ name: "Detour Squirrel" },
			{ OPENROUTER_API_KEY: "sk-openrouter-test" },
		);

		const result = await runtime.dynamicPromptExecFromState(responseArgs);

		expect(calls).toEqual(["original", "original", "original"]);
		expect(seenProviders).toEqual(["active", "active", "openrouter"]);
		expect(result?.action).toBe("REPLY");
	});

	test("normalizes legacy reply planner schema before structured attempt", async () => {
		const plannerSchemas: Array<Array<Record<string, unknown>>> = [];
		const legacyArgs = {
			options: { modelType: ModelType.TEXT_LARGE },
			schema: [
				{ field: "thought", required: true },
				{ field: "providers" },
				{ field: "actions", type: "string", required: true },
				{ field: "text" },
				{ field: "simple" },
			],
			state: {
				values: { recentMessages: "user: Detour hello" },
				text: "Detour hello",
			},
		} as never;
		const { runtime } = makeRuntime(async (args) => {
			plannerSchemas.push((args as { schema: Array<Record<string, unknown>> }).schema);
			return {
				text: "normal reply",
			};
		});

		const result = await runWithPlannerFallbackContext(
			{ source: "discord", addressed: true },
			() => runtime.dynamicPromptExecFromState(legacyArgs),
		);

		const schema = plannerSchemas[0] ?? [];
		const actions = schema.find((row) => row.field === "actions");
		const thought = schema.find((row) => row.field === "thought");
		expect(result?.text).toBe("normal reply");
		expect(actions).toMatchObject({
			type: "array",
			required: false,
			validateField: false,
			streamField: false,
		});
		expect(thought).toMatchObject({
			required: false,
			validateField: false,
			streamField: false,
		});
	});

	test("does not blindly retry unaddressed planner failures", async () => {
		const plannerOptions: unknown[] = [];
		const { runtime, calls } = makeRuntime(async (args) => {
			plannerOptions.push((args as { options?: Record<string, unknown> }).options);
			throw new Error("planner failed");
		});

		await expect(runWithPlannerFallbackContext(
			{ source: "discord", addressed: false },
			() => runtime.dynamicPromptExecFromState(plannerArgs),
		)).rejects.toThrow("planner failed");

		expect(calls).toEqual(["original"]);
		expect(plannerOptions).toEqual([{ modelType: ModelType.ACTION_PLANNER }]);
	});

	test("uses compact state retry for TEXT_LARGE structured failures", async () => {
		const seen: Array<{ modelType?: unknown; recentMessages?: string; providerText?: string }> = [];
		const args = {
			options: { modelType: ModelType.TEXT_LARGE, maxRetries: 3 },
			schema: [
				{ field: "summary" },
				{ field: "category" },
			],
			state: {
				values: { recentMessages: "x".repeat(7_000) },
				text: "x".repeat(7_000),
				data: { providers: { FACTS: { text: "y".repeat(7_000) } } },
			},
		} as never;
		const { runtime, calls } = makeRuntime(async (dynamicArgs) => {
			const typedArgs = dynamicArgs as {
				options?: { modelType?: unknown };
				state?: { values?: { recentMessages?: string }; data?: { providers?: { FACTS?: { text?: string } } } };
			};
			seen.push({
				modelType: typedArgs.options?.modelType,
				recentMessages: typedArgs.state?.values?.recentMessages,
				providerText: typedArgs.state?.data?.providers?.FACTS?.text,
			});
			if (seen.length === 1) throw new Error("TEXT_LARGE schema failed");
			return {
				summary: "compact summary",
				category: "prompt-state-fallback",
			};
		});

		const result = await runtime.dynamicPromptExecFromState(args);

		expect(calls).toEqual(["original", "original"]);
		expect(result?.summary).toBe("compact summary");
		expect(seen[0]?.modelType).toBe(ModelType.TEXT_LARGE);
		expect(seen[1]?.modelType).toBe(ModelType.TEXT_MEDIUM);
		expect((seen[1]?.recentMessages ?? "").length).toBeLessThan(3_000);
		expect((seen[1]?.providerText ?? "").length).toBeLessThan(1_200);
	});

	test("fallback retries with compact prompt after a model failure", async () => {
		const prompts: string[] = [];
		const { runtime, calls } = makeRuntime(
			async () => {
				throw new Error("planner failed");
			},
			async (_modelType, params) => {
				prompts.push((params as { prompt?: string }).prompt ?? "");
				if (prompts.length === 1) throw new Error("context too large");
				return "compact reply";
			},
			{ name: "Detour Squirrel" },
			{ ADDITIONAL_RESPONSE_STATE_PROVIDERS: "FACTS" },
		);
		const argsWithMemory = {
			options: { modelType: ModelType.ACTION_PLANNER },
			schema: [
				{ field: "thought" },
				{ field: "actions" },
				{ field: "providers" },
				{ field: "text" },
				{ field: "simple" },
			],
			state: {
				values: { recentMessages: "user: Detour hello" },
				text: "Detour hello",
				data: {
					providers: {
						FACTS: { text: "Known facts:\n- Remember the unified Detour hub." },
					},
				},
			},
		} as never;

		const result = await runWithPlannerFallbackContext(
			{ source: "discord", addressed: true },
			() => runtime.dynamicPromptExecFromState(argsWithMemory),
		);

		expect(calls).toEqual(["original", "original", "model", "model"]);
		expect(result?.text).toBe("compact reply");
		expect(prompts[0]).toContain("Memory and capability context");
		expect(prompts[1]).toContain("Relevant context");
	});

	test("preserves TEXT_LARGE retry budget before compact recovery", async () => {
		const plannerOptions: unknown[] = [];
		const providerArgs = {
			options: {
				modelType: ModelType.TEXT_LARGE,
				preferredEncapsulation: "toon",
				contextCheckLevel: 0,
				maxRetries: 1,
			},
			schema: [
				{
					field: "providers",
					description: "Provider names",
					type: "array",
					items: { description: "One provider name" },
					required: true,
					validateField: false,
					streamField: false,
				},
			],
			state: {
				values: { recentMessages: "user: check my uploaded file" },
				text: "check my uploaded file",
			},
		} as never;
		const { runtime, calls } = makeRuntime(async (args) => {
			plannerOptions.push((args as { options?: Record<string, unknown> }).options);
			return null;
		});

		const result = await runtime.dynamicPromptExecFromState(providerArgs);

		expect(result).toBeNull();
		expect(calls).toEqual(["original", "original"]);
		expect(plannerOptions[0]).toMatchObject({
			modelType: ModelType.TEXT_LARGE,
			maxRetries: 1,
		});
		expect(plannerOptions[1]).toMatchObject({
			modelType: ModelType.TEXT_MEDIUM,
			preferredEncapsulation: "json",
			forceFormat: "json",
			maxRetries: 0,
			contextCheckLevel: 0,
		});
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

		expect(calls).toEqual(["original", "original", "model"]);
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
			schema: [
				{ field: "thought" },
				{ field: "actions" },
				{ field: "providers" },
				{ field: "text" },
				{ field: "simple" },
			],
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
		} as never;

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
});
