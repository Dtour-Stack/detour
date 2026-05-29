import { describe, expect, test } from "bun:test";
import { XFeedbackService } from "./x-feedback-service";

/** A runtime accessor whose peek() throws, to prove tick() is fail-safe. */
const throwingRuntime = {
	peek() {
		throw new Error("boom");
	},
};

describe("XFeedbackService", () => {
	test("start() then stop() does not throw", () => {
		const svc = new XFeedbackService({ runtime: { peek: () => null }, intervalMs: 60_000 });
		expect(() => svc.start()).not.toThrow();
		expect(() => svc.stop()).not.toThrow();
	});

	test("tick() swallows a thrown runtime error (fail-safe)", async () => {
		const svc = new XFeedbackService({ runtime: throwingRuntime, intervalMs: 60_000 });
		const result = await svc.tick();
		expect(result).toBeNull();
	});

	test("tick() skips gracefully when X creds are absent", async () => {
		const svc = new XFeedbackService({
			runtime: { peek: () => ({ getSetting: () => "" }) as never },
			intervalMs: 60_000,
		});
		const result = await svc.tick();
		expect(result).toEqual({ wrote: false });
	});
});
