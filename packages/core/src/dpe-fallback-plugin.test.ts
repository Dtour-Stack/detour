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
	useModel: () => Promise<string> = async () => "plain reply",
): { runtime: IAgentRuntime; calls: string[] } {
	const calls: string[] = [];
	const runtime = {
		character: { name: "Detour Squirrel" },
		dynamicPromptExecFromState: async () => {
			calls.push("original");
			return await original();
		},
		useModel: async () => {
			calls.push("model");
			return await useModel();
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
});
