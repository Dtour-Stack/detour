import { describe, expect, test } from "bun:test";
import { PensieveGraphService } from "./graph-service";

const MEM_A = { id: "a", entityId: "e1", createdAt: 1000, content: { text: "alpha" }, metadata: { tags: ["news"] } };
const MEM_B = { id: "b", entityId: "e1", createdAt: 2000, content: { text: "beta" }, metadata: { tags: ["news", "draft"] } };
const MEM_C = { id: "c", entityId: "e2", createdAt: 3000, content: { text: "gamma" }, metadata: { tags: ["draft"] } };

const REL_AB = { sourceEntityId: "e1", targetEntityId: "e2", tags: ["friend"] };

const fakeRuntime = {
	getMemories: async () => [MEM_A, MEM_B, MEM_C],
	getRelationships: async () => [REL_AB],
} as never;

describe("PensieveGraphService", () => {
	test("snapshot computes nodes for memories + their entities", async () => {
		const svc = new PensieveGraphService(() => fakeRuntime);
		const snap = await svc.snapshot();
		const memoryNodes = snap.nodes.filter((n) => n.kind === "memory").map((n) => n.id);
		const entityNodes = snap.nodes.filter((n) => n.kind === "entity").map((n) => n.id);
		expect(memoryNodes).toContain("memory:a");
		expect(memoryNodes).toContain("memory:b");
		expect(memoryNodes).toContain("memory:c");
		expect(entityNodes).toContain("entity:e1");
		expect(entityNodes).toContain("entity:e2");
	});

	test("snapshot draws memory→entity + entity↔entity edges", async () => {
		const svc = new PensieveGraphService(() => fakeRuntime);
		const snap = await svc.snapshot();
		const memEntity = snap.edges.filter((e) => e.kind === "memory-entity");
		expect(memEntity.length).toBe(3);
		const rels = snap.edges.filter((e) => e.kind === "entity-relationship");
		expect(rels.length).toBe(1);
	});

	test("memory-tag edges connect memories sharing a tag", async () => {
		const svc = new PensieveGraphService(() => fakeRuntime);
		const snap = await svc.snapshot();
		const tagEdges = snap.edges.filter((e) => e.kind === "memory-tag");
		// "news" connects a↔b ; "draft" connects b↔c → 2 edges total.
		expect(tagEdges.length).toBe(2);
	});

	test("returns zero graph when runtime is null", async () => {
		const svc = new PensieveGraphService(() => null);
		const snap = await svc.snapshot();
		expect(snap.nodes).toEqual([]);
		expect(snap.edges).toEqual([]);
	});

	test("backlinksForMemory returns the memory + its entity + tag-shared memories", async () => {
		const svc = new PensieveGraphService(() => fakeRuntime);
		const result = await svc.backlinksForMemory("a");
		const ids = new Set(result.nodes.map((n) => n.id));
		expect(ids.has("memory:a")).toBe(true);
		expect(ids.has("entity:e1")).toBe(true); // memory→entity
		expect(ids.has("memory:b")).toBe(true);  // shared "news" tag
	});
});
