import { describe, expect, test } from "bun:test";
import { KeyedAsyncLock, SerialAsyncLock } from "./async-lock";

describe("KeyedAsyncLock", () => {
	test("serializes work for the same key", async () => {
		const lock = new KeyedAsyncLock();
		const events: string[] = [];
		const work = async (label: string, delay: number) => {
			events.push(`enter:${label}`);
			await new Promise((r) => setTimeout(r, delay));
			events.push(`exit:${label}`);
			return label;
		};
		const a = lock.run("k", () => work("A", 30));
		// Start B immediately — without locking it would interleave with A.
		const b = lock.run("k", () => work("B", 5));
		await Promise.all([a, b]);
		expect(events).toEqual(["enter:A", "exit:A", "enter:B", "exit:B"]);
	});

	test("parallelizes work across different keys", async () => {
		const lock = new KeyedAsyncLock();
		const events: string[] = [];
		const a = lock.run("alpha", async () => {
			events.push("alpha-start");
			await new Promise((r) => setTimeout(r, 20));
			events.push("alpha-end");
		});
		const b = lock.run("beta", async () => {
			events.push("beta-start");
			await new Promise((r) => setTimeout(r, 5));
			events.push("beta-end");
		});
		await Promise.all([a, b]);
		expect(events).toContain("alpha-start");
		expect(events).toContain("beta-start");
		// beta should finish before alpha (parallel + shorter delay).
		expect(events.indexOf("beta-end")).toBeLessThan(events.indexOf("alpha-end"));
	});

	test("releases the entry when the queue drains", async () => {
		const lock = new KeyedAsyncLock();
		await lock.run("k", async () => {});
		expect(lock.size).toBe(0);
	});

	test("does not strand subsequent work when one job throws", async () => {
		const lock = new KeyedAsyncLock();
		const events: string[] = [];
		const a = lock.run("k", async () => {
			events.push("A");
			throw new Error("boom");
		});
		const b = lock.run("k", async () => {
			events.push("B");
			return "ok";
		});
		await expect(a).rejects.toThrow("boom");
		await expect(b).resolves.toBe("ok");
		expect(events).toEqual(["A", "B"]);
	});

	test("propagates the inner function's return value", async () => {
		const lock = new KeyedAsyncLock();
		const result = await lock.run("k", async () => 42);
		expect(result).toBe(42);
	});
});

describe("SerialAsyncLock", () => {
	test("serializes all calls regardless of key", async () => {
		const lock = new SerialAsyncLock();
		const events: string[] = [];
		const a = lock.run(async () => {
			events.push("A-start");
			await new Promise((r) => setTimeout(r, 20));
			events.push("A-end");
			return 1;
		});
		const b = lock.run(async () => {
			events.push("B-start");
			await new Promise((r) => setTimeout(r, 5));
			events.push("B-end");
			return 2;
		});
		const [ra, rb] = await Promise.all([a, b]);
		expect(events).toEqual(["A-start", "A-end", "B-start", "B-end"]);
		expect(ra).toBe(1);
		expect(rb).toBe(2);
	});

	test("continues after a throwing call", async () => {
		const lock = new SerialAsyncLock();
		const a = lock.run(async () => {
			throw new Error("boom");
		});
		const b = lock.run(async () => "ok");
		await expect(a).rejects.toThrow("boom");
		await expect(b).resolves.toBe("ok");
	});
});
