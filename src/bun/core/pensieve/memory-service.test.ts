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
});
