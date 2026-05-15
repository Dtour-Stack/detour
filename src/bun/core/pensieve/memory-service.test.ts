import { describe, expect, test } from "bun:test";
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { PensieveMemoryService } from "./memory-service";

function makeService(getRoom: (roomId: UUID) => Promise<unknown | null>): {
	service: PensieveMemoryService;
	writes: Memory[];
} {
	const writes: Memory[] = [];
	const runtime = {
		agentId: "00000000-0000-0000-0000-000000000001",
		getRoom,
		getRoomsForParticipant: async () => ["00000000-0000-0000-0000-000000000002"],
		createMemory: async (memory: Memory) => {
			writes.push(memory);
			return "00000000-0000-0000-0000-000000000003";
		},
	} as unknown as IAgentRuntime;
	return {
		service: new PensieveMemoryService(() => runtime),
		writes,
	};
}

describe("PensieveMemoryService", () => {
	test("falls back from an external room id to the agent room when the room is not in the DB", async () => {
		const { service, writes } = makeService(async () => null);

		const result = await service.create({
			text: "discord observation",
			roomId: "00000000-0000-0000-0000-000000000099",
		});

		expect(result?.id).toBe("00000000-0000-0000-0000-000000000003");
		expect(writes[0]?.roomId).toBe("00000000-0000-0000-0000-000000000002");
	});

	test("keeps caller-provided room id when it exists", async () => {
		const { service, writes } = makeService(async () => ({ id: "00000000-0000-0000-0000-000000000099" }));

		await service.create({
			text: "room scoped note",
			roomId: "00000000-0000-0000-0000-000000000099",
		});

		expect(writes[0]?.roomId).toBe("00000000-0000-0000-0000-000000000099");
	});

	test("memoryQuery hook expands a vague prompt into multiple queries; results dedupe", async () => {
		// Track every embedding-search call to confirm we ran one PER expanded query.
		const embeddings: string[] = [];
		// Two of three queries return the same memory id; verify the merged
		// result deduplicates.
		const runtime = {
			agentId: "00000000-0000-0000-0000-000000000001",
			useModel: async (_type: string, params: { text: string }) => {
				embeddings.push(params.text);
				return [0.1, 0.2, 0.3]; // non-zero embedding triggers vector path
			},
			searchMemories: async (params: { embedding: unknown }) => {
				void params;
				// All queries return the same single memory — dedupe must collapse.
				return [
					{
						id: "mem-id-1" as UUID,
						content: { text: "shared deployment memory" },
						roomId: "room-1" as UUID,
						entityId: "e-1" as UUID,
						agentId: "a-1" as UUID,
						embedding: [0.1, 0.2, 0.3],
						createdAt: Date.now(),
						metadata: { path: "/deploy", type: "description" },
					} as Memory,
				];
			},
		} as unknown as IAgentRuntime;
		const service = new PensieveMemoryService(() => runtime);
		service.setMemoryQueryHook(async () => [
			"deployment yesterday",
			"deploy history",
			"deployment timeline",
		]);

		const results = await service.search(
			"remind me what we said about the deployment yesterday",
		);

		// Three expanded queries were embedded:
		expect(embeddings.length).toBe(3);
		expect(embeddings).toEqual([
			"deployment yesterday",
			"deploy history",
			"deployment timeline",
		]);
		// But after dedupe by id, only ONE hit comes back:
		expect(results.length).toBe(1);
		expect(results[0]?.id).toBe("mem-id-1");
	});

	test("memoryQuery hook returning null falls through to legacy single-query path", async () => {
		let embedCount = 0;
		const runtime = {
			agentId: "00000000-0000-0000-0000-000000000001",
			useModel: async () => {
				embedCount += 1;
				return [0.1, 0.2];
			},
			searchMemories: async () => [],
		} as unknown as IAgentRuntime;
		const service = new PensieveMemoryService(() => runtime);
		// Hook says "couldn't decide" — search must run ONCE on the raw text.
		service.setMemoryQueryHook(async () => null);

		const results = await service.search("what was that thing");

		expect(embedCount).toBe(1);
		expect(results).toEqual([]);
	});

	test("memoryQuery hook throwing does not break search (legacy path still runs)", async () => {
		let embedCount = 0;
		const runtime = {
			agentId: "00000000-0000-0000-0000-000000000001",
			useModel: async () => {
				embedCount += 1;
				return [0.1, 0.2];
			},
			searchMemories: async () => [],
		} as unknown as IAgentRuntime;
		const service = new PensieveMemoryService(() => runtime);
		service.setMemoryQueryHook(async () => {
			throw new Error("companion unreachable");
		});

		// Should not throw — search swallows hook failure.
		const results = await service.search("anything");
		expect(embedCount).toBe(1);
		expect(results).toEqual([]);
	});
});
