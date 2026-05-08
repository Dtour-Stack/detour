import { describe, expect, test } from "bun:test";
import type { Entity, IAgentRuntime, Memory, Relationship, UUID } from "@elizaos/core";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discordContextForMessage } from "./discord-context-provider";

function withStateDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
	const previous = process.env.ELIZA_STATE_DIR;
	const dir = mkdtempSync(join(tmpdir(), "detour-discord-context-"));
	process.env.ELIZA_STATE_DIR = dir;
	return run(dir).finally(() => {
		if (previous === undefined) delete process.env.ELIZA_STATE_DIR;
		else process.env.ELIZA_STATE_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	});
}

function writeGatewayLog(dir: string, rows: Array<Record<string, unknown>>): void {
	const gatewayDir = join(dir, "gateway");
	mkdirSync(gatewayDir, { recursive: true });
	writeFileSync(join(gatewayDir, "messages.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n"));
}

function runtime(memories: Partial<Record<string, Memory[]>> = {}): IAgentRuntime {
	const agentId = "0b0d99a5-666d-0f9f-9c12-3c0022b95db3" as UUID;
	const entities = new Map<string, Entity>([
		["c2269992-d475-04ad-ab68-7dff9209c695", { id: "c2269992-d475-04ad-ab68-7dff9209c695" as UUID, names: ["dEXploarer"] } as Entity],
		["e9fcbf6b-8987-0787-b463-af50b1b9ff00", { id: "e9fcbf6b-8987-0787-b463-af50b1b9ff00" as UUID, names: ["fishai"] } as Entity],
	]);
	return {
		agentId,
		getRelationships: async () => [
			{ sourceEntityId: agentId, targetEntityId: "c2269992-d475-04ad-ab68-7dff9209c695" as UUID, tags: ["discord", "discord-user"] },
			{ sourceEntityId: agentId, targetEntityId: "e9fcbf6b-8987-0787-b463-af50b1b9ff00" as UUID, tags: ["discord", "discord-user"] },
		] as Relationship[],
		getEntitiesByIds: async (ids: UUID[]) => ids.flatMap((id) => {
			const entity = entities.get(String(id));
			return entity ? [entity] : [];
		}),
		getMemories: async (params: Record<string, unknown>) => memories[String(params.tableName)] ?? [],
	} as never;
}

describe("discord context provider", () => {
	test("builds current speaker, known people, and persisted room turns", async () => {
		await withStateDir(async (dir) => {
			const roomId = "cdfea3ca-9b95-0125-8155-dc4308f7f806";
			writeGatewayLog(dir, [
				{
					id: "1",
					time: 1,
					direction: "in",
					channel: "discord",
					source: "discord",
					roomId,
					entityId: "c2269992-d475-04ad-ab68-7dff9209c695",
					externalHandle: "458148462639316993",
					text: "[Discord #cozy] @dEXploarer (Wed): Detour any fud on X lately?",
				},
				{
					id: "2",
					time: 2,
					direction: "out",
					channel: "discord",
					source: "discord",
					roomId,
					entityId: "0b0d99a5-666d-0f9f-9c12-3c0022b95db3",
					text: "Always. X runs on caffeine.",
				},
				{
					id: "3",
					time: 3,
					direction: "in",
					channel: "discord",
					source: "discord",
					roomId,
					entityId: "e9fcbf6b-8987-0787-b463-af50b1b9ff00",
					externalHandle: "1281434689910997084",
					text: "[Discord #cozy] @fishai (Wed): botdick is your dev? damnnn",
				},
			]);
			const message: Memory = {
				roomId: roomId as UUID,
				entityId: "c2269992-d475-04ad-ab68-7dff9209c695" as UUID,
				content: { source: "discord", text: "Detour what did fishai mean?" },
			};

			const text = await discordContextForMessage(runtime(), message);

			expect(text).toContain("Current speaker: dEXploarer");
			expect(text).toContain("Detour's dev/operator");
			expect(text).toContain("fishai");
			expect(text).toContain("botdick is your dev");
			expect(text).toContain("Detour Squirrel: Always. X runs on caffeine.");
		});
	});

	test("includes saved Discord notes and hides internal generation failures", async () => {
		await withStateDir(async (dir) => {
			const roomId = "cdfea3ca-9b95-0125-8155-dc4308f7f806";
			writeGatewayLog(dir, [
				{
					id: "1",
					time: 1,
					direction: "out",
					channel: "discord",
					source: "discord",
					roomId,
					entityId: "0b0d99a5-666d-0f9f-9c12-3c0022b95db3",
					text: "Reply generation failed inside my provider path: server_is_overloaded apiKey=set",
				},
			]);
			const message: Memory = {
				roomId: roomId as UUID,
				entityId: "c2269992-d475-04ad-ab68-7dff9209c695" as UUID,
				content: { source: "discord", text: "Detour what happened?" },
			};
			const text = await discordContextForMessage(runtime({
				memories: [{
					id: "note-1" as UUID,
					roomId: roomId as UUID,
					entityId: "0b0d99a5-666d-0f9f-9c12-3c0022b95db3" as UUID,
					content: { text: "Dexploarer expects Detour to inspect X notifications directly." },
					metadata: { type: "description", ...{ path: `/discord/rooms/${roomId}/observations` } },
					createdAt: 1,
				}],
				facts: [{
					id: "fact-1" as UUID,
					roomId: roomId as UUID,
					entityId: "c2269992-d475-04ad-ab68-7dff9209c695" as UUID,
					content: { text: "Dexploarer is Detour's dev/operator." },
					metadata: { type: "custom", ...{ path: "/facts/discord/people" } },
					createdAt: 2,
				}],
			}), message);

			expect(text).toContain("Saved Discord notes/facts");
			expect(text).toContain("inspect X notifications directly");
			expect(text).toContain("Dexploarer is Detour's dev/operator.");
			expect(text).toContain("internal generation failure");
			expect(text).not.toContain("server_is_overloaded");
			expect(text).not.toContain("apiKey=set");
		});
	});
});
