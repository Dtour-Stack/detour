import { describe, expect, test } from "bun:test";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { agentHfDatasetSyncAction, agentPublicLogPlugin } from "./index";

describe("agent public log plugin", () => {
	test("registers GitHub and Hugging Face dump actions", () => {
		expect(agentPublicLogPlugin.actions?.map((action) => action.name)).toEqual([
			"AGENT_PUBLIC_LOG_PUBLISH",
			"AGENT_HF_DATASET_SYNC",
		]);
	});

	test("Hugging Face sync action documents the default hf sync command", () => {
		expect(agentHfDatasetSyncAction.description).toContain(
			"hf sync ./data hf://buckets/dexploarer/detourdump",
		);
	});

	test("Hugging Face sync action rejects non-hf destinations before staging a dump", async () => {
		const result = await agentHfDatasetSyncAction.handler(
			{ character: { name: "Test Agent" } } as IAgentRuntime,
			{ entityId: "operator" } as Memory,
			undefined,
			{ parameters: { destination: "https://huggingface.co/bad-target" } },
		);

		expect(result?.success).toBe(false);
		expect(result?.text).toContain("hf://");
	});
});
