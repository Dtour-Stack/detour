import { describe, expect, test } from "bun:test";
import { XStyleService } from "./x-style-service";

/** A runtime accessor whose peek() throws, to prove tick() is fail-safe. */
const throwingRuntime = {
	peek() {
		throw new Error("boom");
	},
};

describe("XStyleService", () => {
	test("start() then stop() does not throw", () => {
		const svc = new XStyleService({
			runtime: { peek: () => null },
			memories: { create: () => Promise.resolve({ id: "1" }) },
			intervalMs: 60_000,
		});
		expect(() => svc.start()).not.toThrow();
		expect(() => svc.stop()).not.toThrow();
	});

	test("tick() swallows a thrown runtime error (fail-safe)", async () => {
		const svc = new XStyleService({
			runtime: throwingRuntime,
			memories: { create: () => Promise.resolve({ id: "1" }) },
			intervalMs: 60_000,
		});
		const result = await svc.tick();
		expect(result).toBeNull();
	});

	test("tick() skips gracefully when X creds are absent", async () => {
		const svc = new XStyleService({
			runtime: {
				peek: () =>
					({
						getSetting: () => "",
						useModel: () => Promise.reject(new Error("should not be called")),
					}) as never,
			},
			memories: { create: () => Promise.reject(new Error("should not be called")) },
			intervalMs: 60_000,
		});
		const result = await svc.tick();
		expect(result).toEqual({ wrote: false });
	});
});
