/**
 * MemoryArbiter contract tests. Drives the arbiter at fixed totalGB +
 * headroomGB so the test is deterministic across machines — the real
 * service uses `os.totalmem()` but production code paths only consult
 * the arbiter through `shouldAllowStart` so the math under test is the
 * same.
 */
import { describe, expect, test } from "bun:test";
import { MemoryArbiter } from "./memory-arbiter";

const SIXTEEN_GB = { totalGB: 16, headroomGB: 6 }; // budget = 10 GB
const THIRTYTWO_GB = { totalGB: 32, headroomGB: 9.6 }; // budget = 22.4 GB

describe("MemoryArbiter budget math", () => {
	test("16 GB Mac: chat 6 GB allowed, then companion 3 GB allowed (total 9 ≤ 10 budget)", () => {
		const a = new MemoryArbiter(SIXTEEN_GB);
		a.reserve("embedding", 0.5);
		expect(a.shouldAllowStart("chat", 6).ok).toBe(true);
		a.reserve("chat", 6);
		expect(a.shouldAllowStart("companion", 3).ok).toBe(true);
	});

	test("16 GB Mac: chat 11 GB (Qwen3-8B) blocked because it alone exceeds 10 GB budget", () => {
		const a = new MemoryArbiter(SIXTEEN_GB);
		a.reserve("embedding", 0.5);
		const decision = a.shouldAllowStart("chat", 11);
		expect(decision.ok).toBe(false);
		expect(decision.reason).toMatch(/Not enough RAM/);
		expect(decision.reason).toContain("11.0 GB");
		expect(decision.reason).toContain("10.0 GB"); // the budget figure
	});

	test("16 GB Mac: chat 8 GB + companion 4 GB blocked when total exceeds budget", () => {
		const a = new MemoryArbiter(SIXTEEN_GB);
		a.reserve("embedding", 0.5);
		a.reserve("chat", 8);
		const decision = a.shouldAllowStart("companion", 4);
		// 0.5 + 8 + 4 = 12.5 > 10 budget. Refused.
		expect(decision.ok).toBe(false);
		expect(decision.reason).toContain("companion");
		expect(decision.reason).toContain("chat");
	});

	test("32 GB Mac: same chat+companion combination is allowed (budget = 22.4 GB)", () => {
		const a = new MemoryArbiter(THIRTYTWO_GB);
		a.reserve("embedding", 0.5);
		a.reserve("chat", 8);
		expect(a.shouldAllowStart("companion", 4).ok).toBe(true);
	});

	test("re-reserving the same tier is evaluated as a swap, not an addition", () => {
		const a = new MemoryArbiter(SIXTEEN_GB);
		a.reserve("embedding", 0.5);
		a.reserve("chat", 6);
		// User wants to swap chat from 6 GB → 9 GB. Total would be 9.5 ≤ 10
		// budget. Allowed even though 9 + previously-held 6 = 15 > budget.
		expect(a.shouldAllowStart("chat", 9).ok).toBe(true);
	});

	test("release() frees the tier's reservation", () => {
		const a = new MemoryArbiter(SIXTEEN_GB);
		a.reserve("embedding", 0.5);
		a.reserve("chat", 8);
		// companion 4 GB blocked while chat holds 8 GB.
		expect(a.shouldAllowStart("companion", 4).ok).toBe(false);
		a.release("chat");
		// After release, companion 4 GB fits inside the budget.
		expect(a.shouldAllowStart("companion", 4).ok).toBe(true);
	});

	test("inspect() exposes a budget snapshot for the UI", () => {
		const a = new MemoryArbiter(SIXTEEN_GB);
		a.reserve("embedding", 0.5);
		a.reserve("chat", 6);
		const snap = a.inspect();
		expect(snap.totalGB).toBe(16);
		expect(snap.headroomGB).toBe(6);
		expect(snap.budgetGB).toBe(10);
		expect(snap.usedGB).toBe(6.5);
		expect(snap.reservations.map((r) => r.tier).sort()).toEqual([
			"chat",
			"embedding",
		]);
	});

	test("default headroom is at least 6 GB even on tiny machines", () => {
		const a = new MemoryArbiter({ totalGB: 8 });
		// headroom defaulted to max(6, 0.3 * 8) = 6 → budget = 2 GB. Any
		// non-trivial model is rejected, which is the correct posture on
		// a 8 GB Mac.
		expect(a.shouldAllowStart("chat", 3).ok).toBe(false);
	});

	test("never blocks when totalGB is non-finite (assume user knows what they're doing)", () => {
		const a = new MemoryArbiter({ totalGB: 0 });
		expect(a.shouldAllowStart("chat", 100).ok).toBe(true);
	});
});
