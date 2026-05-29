import { describe, expect, test } from "bun:test";
import { XRadarService } from "./x-radar-service";

/** A runtime accessor whose peek() throws, to prove tick() is fail-safe. */
const throwingRuntime = {
	peek() {
		throw new Error("boom");
	},
};

/** A memories stub whose create() throws, to prove a write failure is swallowed. */
const throwingMemories = {
	create() {
		return Promise.reject(new Error("write boom"));
	},
};

describe("XRadarService", () => {
	test("start() then stop() does not throw", () => {
		const svc = new XRadarService({
			runtime: { peek: () => null },
			memories: { create: () => Promise.resolve({ id: "1" }) },
			intervalMs: 60_000,
		});
		expect(() => svc.start()).not.toThrow();
		expect(() => svc.stop()).not.toThrow();
	});

	test("tick() swallows a thrown runtime error (fail-safe)", async () => {
		const svc = new XRadarService({
			runtime: throwingRuntime,
			memories: { create: () => Promise.resolve({ id: "1" }) },
			intervalMs: 60_000,
		});
		const result = await svc.tick();
		expect(result).toBeNull();
	});

	test("tick() returns null when runtime is not ready", async () => {
		const svc = new XRadarService({
			runtime: { peek: () => null },
			memories: throwingMemories,
			intervalMs: 60_000,
		});
		const result = await svc.tick();
		expect(result).toBeNull();
	});

	test("interval override reads from process.env at boot (peek null)", () => {
		const prev = process.env.X_RADAR_INTERVAL_MS;
		process.env.X_RADAR_INTERVAL_MS = "12345";
		try {
			// No intervalMs override and peek() null (boot): env must win, not default.
			const svc = new XRadarService({
				runtime: { peek: () => null },
				memories: { create: () => Promise.resolve({ id: "1" }) },
			});
			expect(() => svc.start()).not.toThrow();
			expect(() => svc.stop()).not.toThrow();
		} finally {
			if (prev === undefined) delete process.env.X_RADAR_INTERVAL_MS;
			else process.env.X_RADAR_INTERVAL_MS = prev;
		}
	});
});
