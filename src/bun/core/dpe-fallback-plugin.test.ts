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
	original: () => Promise<unknown>,
	useModel: (modelType: unknown, params: unknown) => Promise<string> = async () => "plain reply",
	character: Record<string, unknown> = { name: "Detour Squirrel" },
): { runtime: IAgentRuntime; calls: string[] } {
	const calls: string[] = [];
	const runtime = {
		character,
		dynamicPromptExecFromState: async () => {
			calls.push("original");
			return await original();
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
});
