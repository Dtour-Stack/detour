import { describe, expect, test } from "bun:test";
import { ModelType } from "@elizaos/core";
import { embeddingStubPlugin } from "./embedding-stub-plugin";

describe("embeddingStubPlugin", () => {
	test("registers TEXT_EMBEDDING model handler", () => {
		expect(embeddingStubPlugin.models?.[ModelType.TEXT_EMBEDDING]).toBeDefined();
	});

	test("returns 1536-dim zero vector (matches text-embedding-3-small contract)", async () => {
		const handler = embeddingStubPlugin.models![ModelType.TEXT_EMBEDDING] as (...args: unknown[]) => Promise<number[]>;
		const out = await handler({} as never, { text: "anything" } as never);
		expect(Array.isArray(out)).toBe(true);
		expect(out.length).toBe(1536);
		expect(out.every((n) => n === 0)).toBe(true);
	});

	test("regression: same shape regardless of input — never throws or returns null", async () => {
		const handler = embeddingStubPlugin.models![ModelType.TEXT_EMBEDDING] as (...args: unknown[]) => Promise<number[]>;
		for (const input of [null, undefined, "x", { text: "y" }, ""]) {
			const out = await handler({} as never, input as never);
			expect(out.length).toBe(1536);
		}
	});
});
