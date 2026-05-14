import { describe, expect, test } from "bun:test";
import { AgentRuntime, ModelType, type GenerateTextParams, type Plugin, type TextStreamResult } from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import {
	tagLlmPluginPriorities,
	LLM_ACTIVE_PLUGIN_PRIORITY,
	LLM_RECOVERY_PLUGIN_PRIORITY,
} from "./runtime";

/**
 * Regression: when more than one LLM plugin is loaded (e.g. the user has
 * an Anthropic OAuth subscription paired AND an OPENROUTER_API_KEY in the
 * vault for recovery), each plugin registers a TEXT_LARGE handler at the
 * same default priority (0). elizaOS's `AgentRuntime.resolveModelRegistration`
 * tie-breaks on registration order, which is non-deterministic across
 * dynamic `await import()` boundaries. Production logs showed Anthropic
 * marked active but every `useModel(TEXT_LARGE)` call landing on
 * OpenRouter's `openrouter/free` (→ `google/gemma-4-31b-it:free`) handler.
 *
 * The fix in `runtime.ts → tagLlmPluginPriorities` pins the active plugin
 * to +100 and recovery plugins to -100. This test validates the fix
 * against the REAL `@elizaos/core` `AgentRuntime` resolution path (not a
 * mock of it) — that's what the prior synthetic test was missing.
 */

function makePlugin(
	name: string,
	handler: () => Promise<string>,
): Plugin {
	return {
		name,
		description: `${name} test plugin`,
		models: {
			[ModelType.TEXT_LARGE]: ((async (
				_runtime: import("@elizaos/core").IAgentRuntime,
				_params: GenerateTextParams,
			): Promise<string | TextStreamResult> => handler()) as never),
		},
	};
}

async function buildRuntimeWithPlugins(plugins: Plugin[]): Promise<AgentRuntime> {
	const runtime = new AgentRuntime({
		agentId: stringToUuid("plugin-priority-test"),
		character: { name: "PriorityProbe", bio: ["probe"] },
		plugins,
		settings: { ALLOW_NO_DATABASE: "true" },
	});
	await runtime.initialize({ allowNoDatabase: true });
	return runtime;
}

describe("tagLlmPluginPriorities — real elizaOS AgentRuntime resolution", () => {
	test("priority constants match the documented intent", () => {
		// Pin the magnitudes — these can't be silently shrunk to e.g. ±1
		// without breaking the ordering against default-priority-0 plugins
		// like embeddingOpenAIPlugin that are loaded in `basePlugins`.
		expect(LLM_ACTIVE_PLUGIN_PRIORITY).toBeGreaterThanOrEqual(100);
		expect(LLM_RECOVERY_PLUGIN_PRIORITY).toBeLessThanOrEqual(-100);
	});

	test("tagLlmPluginPriorities tags active=+100, recovery=-100", () => {
		const anthropic = makePlugin("anthropic", async () => "anthropic-out");
		const openrouter = makePlugin("openrouter", async () => "openrouter-out");
		const elizacloud = makePlugin("elizacloud", async () => "elizacloud-out");
		const out = tagLlmPluginPriorities([anthropic, openrouter, elizacloud]);
		expect(out[0]!.priority).toBe(LLM_ACTIVE_PLUGIN_PRIORITY);
		expect(out[1]!.priority).toBe(LLM_RECOVERY_PLUGIN_PRIORITY);
		expect(out[2]!.priority).toBe(LLM_RECOVERY_PLUGIN_PRIORITY);
	});

	test("default useModel(TEXT_LARGE) lands on active plugin via real AgentRuntime resolution", async () => {
		// Worst-case scenario: register openrouter FIRST so under the
		// OLD code (no priorities) it would have won on registration
		// order. With the fix, anthropic still wins.
		const openrouter = makePlugin("openrouter", async () => "openrouter-out");
		const anthropic = makePlugin("anthropic", async () => "anthropic-out");
		const tagged = tagLlmPluginPriorities([anthropic, openrouter]);
		// Reverse so the recovery plugin enters the runtime's registry first.
		const runtime = await buildRuntimeWithPlugins([tagged[1]!, tagged[0]!]);
		try {
			const out = await runtime.useModel(ModelType.TEXT_LARGE, {
				prompt: "ping",
			} as unknown as GenerateTextParams);
			expect(out).toBe("anthropic-out");
		} finally {
			await runtime.stop().catch(() => undefined);
		}
	});

	test("dpe-fallback recovery: explicit provider:'openrouter' still resolves to openrouter", async () => {
		// `dpe-fallback-plugin.ts → providerRecoveryArgs` sets
		// `options.model = "openrouter"`, which elizaOS forwards as the
		// `provider` argument to `useModel`. That lookup uses `.find()`
		// by name, so the -100 priority must NOT block recovery.
		const openrouter = makePlugin("openrouter", async () => "openrouter-out");
		const anthropic = makePlugin("anthropic", async () => "anthropic-out");
		const tagged = tagLlmPluginPriorities([anthropic, openrouter]);
		const runtime = await buildRuntimeWithPlugins(tagged);
		try {
			const out = await runtime.useModel(
				ModelType.TEXT_LARGE,
				{ prompt: "ping" } as unknown as import("@elizaos/core").GenerateTextParams,
				"openrouter",
			);
			expect(out).toBe("openrouter-out");
			// And default still wins for anthropic.
			const def = await runtime.useModel(ModelType.TEXT_LARGE, {
				prompt: "ping",
			} as unknown as GenerateTextParams);
			expect(def).toBe("anthropic-out");
		} finally {
			await runtime.stop().catch(() => undefined);
		}
	});

	test("4-provider build (anthropic-active + 3 recovery): anthropic still wins default", async () => {
		const anthropic = makePlugin("anthropic", async () => "anthropic-out");
		const openrouter = makePlugin("openrouter", async () => "openrouter-out");
		const elizacloud = makePlugin("elizacloud", async () => "elizacloud-out");
		const openai = makePlugin("openai", async () => "openai-out");
		const tagged = tagLlmPluginPriorities([anthropic, openrouter, elizacloud, openai]);
		// Worst-case registration order — every recovery plugin before active.
		const runtime = await buildRuntimeWithPlugins([
			tagged[3]!,
			tagged[2]!,
			tagged[1]!,
			tagged[0]!,
		]);
		try {
			const out = await runtime.useModel(ModelType.TEXT_LARGE, {
				prompt: "ping",
			} as unknown as GenerateTextParams);
			expect(out).toBe("anthropic-out");
		} finally {
			await runtime.stop().catch(() => undefined);
		}
	});

	test("priority gap dominates a default-priority-0 plugin (embedding/skills etc.)", async () => {
		// `embeddingOpenAIPlugin`, `vaultToolsPlugin`, etc. in
		// `runtime.ts → basePlugins` are loaded with no explicit
		// priority. If one of them happened to register a TEXT_LARGE
		// handler (e.g. via a misconfigured plugin), the active-LLM
		// plugin at +100 must still win.
		const anthropic = makePlugin("anthropic", async () => "anthropic-out");
		const openrouter = makePlugin("openrouter", async () => "openrouter-out");
		const tagged = tagLlmPluginPriorities([anthropic, openrouter]);
		const stray: Plugin = makePlugin("stray-default-priority", async () => "stray-out");
		const runtime = await buildRuntimeWithPlugins([stray, ...tagged]);
		try {
			const out = await runtime.useModel(ModelType.TEXT_LARGE, {
				prompt: "ping",
			} as unknown as GenerateTextParams);
			expect(out).toBe("anthropic-out");
		} finally {
			await runtime.stop().catch(() => undefined);
		}
	});
});
