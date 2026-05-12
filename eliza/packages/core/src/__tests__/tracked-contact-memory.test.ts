import { afterEach, describe, expect, it } from "vitest";
import { relationshipsPlugin } from "../plugins/native-features";
import type { RelationshipsService } from "../services/relationships";
import { createTestRuntime, type TestRuntimeResult } from "../testing/pglite-runtime";
import { ChannelType, type MemoryMetadata, type UUID } from "../types";
import { stringToUuid } from "../utils";

let testRuntime: TestRuntimeResult | null = null;

afterEach(async () => {
	await testRuntime?.cleanup();
	testRuntime = null;
});

describe("tracked contact memory capture", () => {
	it("tags persisted messages and records an interaction for tracked contacts", async () => {
		testRuntime = await createTestRuntime({ plugins: [relationshipsPlugin] });
		const { runtime } = testRuntime;
		const entityId = stringToUuid("tracked-contact:shaw") as UUID;
		const roomId = stringToUuid("tracked-contact:room") as UUID;
		const worldId = stringToUuid("tracked-contact:world") as UUID;
		await runtime.createEntity({
			id: entityId,
			agentId: runtime.agentId,
			names: ["Shaw"],
		});
		await runtime.ensureConnection({
			entityId,
			roomId,
			worldId,
			name: "Shaw",
			userName: "Shaw",
			source: "test",
			type: ChannelType.DM,
		});

		const relationships = runtime.getService("relationships") as RelationshipsService;
		await relationships.setContactTracking(entityId, true);
		const memoryId = await runtime.createMemory(
			{
				entityId,
				roomId,
				content: { text: "Shaw sent the updated notes.", source: "test" },
				createdAt: Date.now(),
			},
			"messages",
		);

		const memory = await runtime.getMemoryById(memoryId);
		const metadata = memory?.metadata as (MemoryMetadata & {
			tags?: string[];
			trackedContactEntityIds?: string[];
		}) | undefined;
		const contact = await relationships.getContact(entityId);

		expect(metadata?.tags).toContain("tracked-contact");
		expect(metadata?.trackedContactEntityIds).toContain(entityId);
		expect(contact?.interactions).toHaveLength(1);
		expect(contact?.interactions[0]?.externalRef).toBe(memoryId);
	});
});
