import { describe, expect, test } from "bun:test";
import { BuildCoordinator } from "./build-coordinator";

/** Controllable clock so we can advance time deterministically. */
function clockAt(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
	let t = start;
	return { now: () => t, advance: (ms) => { t += ms; } };
}

describe("BuildCoordinator", () => {
	test("first tryStart claims the room", () => {
		const c = new BuildCoordinator(() => 1000);
		expect(c.tryStart("room1", "todo app")).toEqual({ ok: true });
		expect(c.activeLabel("room1")).toBe("todo app");
	});

	test("second tryStart while building is rejected as busy with label + age", () => {
		const clk = clockAt();
		const c = new BuildCoordinator(clk.now);
		expect(c.tryStart("room1", "todo app").ok).toBe(true);
		clk.advance(30_000);
		const r = c.tryStart("room1", "another app");
		expect(r).toEqual({ ok: false, reason: "busy", label: "todo app", secondsAgo: 30 });
	});

	test("a different room is independent", () => {
		const c = new BuildCoordinator(() => 1000);
		expect(c.tryStart("room1", "a").ok).toBe(true);
		expect(c.tryStart("room2", "b").ok).toBe(true);
	});

	test("finish releases the lock but opens a cooldown", () => {
		const clk = clockAt();
		const c = new BuildCoordinator(clk.now);
		c.tryStart("room1", "todo app");
		c.finish("room1");
		expect(c.activeLabel("room1")).toBeNull();
		// immediately after finishing → cooldown rejection
		const r = c.tryStart("room1", "next app");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("cooldown");
	});

	test("cooldown expires after the quiet window", () => {
		const clk = clockAt();
		const c = new BuildCoordinator(clk.now);
		c.tryStart("room1", "todo app");
		c.finish("room1");
		clk.advance(91_000); // past COOLDOWN_MS (90s)
		expect(c.tryStart("room1", "next app")).toEqual({ ok: true });
	});

	test("stale lock auto-expires via TTL so a crashed build can't lock forever", () => {
		const clk = clockAt();
		const c = new BuildCoordinator(clk.now);
		c.tryStart("room1", "doomed app");
		clk.advance(15 * 60_000 + 1); // past BUILD_TTL_MS
		// no finish() ever called, but the next request goes through
		expect(c.tryStart("room1", "fresh app")).toEqual({ ok: true });
		expect(c.activeLabel("room1")).toBe("fresh app");
	});

	test("note() refreshes activity so a long live build doesn't expire mid-flight", () => {
		const clk = clockAt();
		const c = new BuildCoordinator(clk.now);
		c.tryStart("room1", "big app");
		clk.advance(14 * 60_000);
		c.note("room1"); // still working — refresh
		clk.advance(14 * 60_000); // 28 min total, but only 14 since the note
		const r = c.tryStart("room1", "other app");
		expect(r.ok).toBe(false); // still locked
		if (!r.ok) expect(r.reason).toBe("busy");
	});

	test("empty roomId is handled (single shared no-room slot)", () => {
		const c = new BuildCoordinator(() => 1000);
		expect(c.tryStart("", "a").ok).toBe(true);
		expect(c.tryStart("", "b").ok).toBe(false);
	});
});
