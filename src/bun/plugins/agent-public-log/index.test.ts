import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { IAgentRuntime, Memory, Relationship } from "@elizaos/core";
import { agentHfDatasetSyncAction, agentPublicLogPlugin, syncAgentDumpToHf } from "./index";

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

	test("Hugging Face sync stages data and invokes the default hf sync command", async () => {
		const root = mkdtempSync(join(tmpdir(), "detour-hf-action-test-"));
		const bin = join(root, "bin");
		const capture = join(root, "capture");
		mkdirSync(bin);
		mkdirSync(capture);
		const hfPath = join(bin, "hf");
		writeFileSync(hfPath, [
			"#!/bin/sh",
			"if [ \"$1\" = \"version\" ]; then echo \"hf 1.14.0\"; exit 0; fi",
			"printf '%s\\n' \"$PWD\" > \"$CAPTURE_DIR/cwd\"",
			"printf '%s\\n' \"$@\" > \"$CAPTURE_DIR/args\"",
			"test \"$1\" = \"sync\" || exit 11",
			"test \"$2\" = \"./data\" || exit 12",
			"test \"$3\" = \"hf://buckets/dexploarer/detourdump\" || exit 13",
			"test -f \"./data/manifest.json\" || exit 14",
			"test -f \"./data/trajectories.jsonl\" || exit 15",
			"test -f \"./data/all-memories.jsonl\" || exit 16",
			"test -f \"./data/relationships.jsonl\" || exit 17",
		].join("\n"));
		chmodSync(hfPath, 0o755);

		const prevPath = process.env.PATH;
		const prevCapture = process.env.CAPTURE_DIR;
		process.env.PATH = `${bin}:${prevPath ?? ""}`;
		process.env.CAPTURE_DIR = capture;
		try {
			const runtime = {
				agentId: "agent-1",
				character: { name: "Test Agent" },
				getService: (name: string) => name === "trajectories"
					? {
						listTrajectories: async () => ({
							trajectories: [{ id: "trajectory-1", source: "chat", text: "hello" }],
							total: 1,
						}),
						getTrajectoryDetail: async (id: string) => ({ id, steps: [{ text: "detail" }] }),
					}
					: null,
				getMemories: async ({ tableName }: { tableName: string }) => (
					tableName === "memories"
						? [{
							id: "memory-1",
							entityId: "agent-1",
							roomId: "room-1",
							content: { text: "knowledge" },
							metadata: { type: "fact" },
						} as Memory]
						: []
				),
				getRelationships: async () => [{
					id: "relationship-1",
					agentId: "agent-1",
					sourceEntityId: "agent-1",
					targetEntityId: "user-1",
					tags: ["test"],
					metadata: {},
				} as Relationship],
			} as Partial<IAgentRuntime> & {
				getMemories: (opts: { tableName: string }) => Promise<Memory[]>;
				getRelationships: () => Promise<Relationship[]>;
			};

			const result = await syncAgentDumpToHf(runtime as IAgentRuntime);

			expect(readFileSync(join(capture, "args"), "utf8").trim().split("\n")).toEqual([
				"sync",
				"./data",
				"hf://buckets/dexploarer/detourdump",
			]);
			expect(readFileSync(join(capture, "cwd"), "utf8")).toContain("detour-agent-dump-");
			expect(result.summary).toContain("hf sync ./data hf://buckets/dexploarer/detourdump");
		} finally {
			if (prevPath === undefined) delete process.env.PATH;
			else process.env.PATH = prevPath;
			if (prevCapture === undefined) delete process.env.CAPTURE_DIR;
			else process.env.CAPTURE_DIR = prevCapture;
			rmSync(root, { recursive: true, force: true });
		}
	});
});
