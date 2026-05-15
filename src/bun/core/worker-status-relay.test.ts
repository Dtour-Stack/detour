import { describe, expect, test } from "bun:test";
import {
	createWorkerStatusRelay,
	formatStatusSummary,
	type RawPtySessionEvent,
} from "./worker-status-relay";

describe("formatStatusSummary", () => {
	test("session_ready reads as 'online and ready'", () => {
		expect(formatStatusSummary("Hungover Owl", { type: "session_ready" })).toBe(
			"Hungover Owl is online and ready.",
		);
	});

	test("tool_running with tool name + target reads naturally", () => {
		const text = formatStatusSummary("Tax-Evading Capybara", {
			type: "tool_running",
			data: { tool: "read", path: "package.json" },
		});
		expect(text).toContain("Tax-Evading Capybara");
		expect(text).toContain("read");
		expect(text).toContain("package.json");
	});

	test("tool_running with tool name but no target", () => {
		const text = formatStatusSummary("Vegan Hyena", {
			type: "tool_running",
			tool: "bash",
		});
		expect(text).toBe("Vegan Hyena is using bash.");
	});

	test("tool_running with neither tool nor target falls back generic", () => {
		const text = formatStatusSummary("Sober Raccoon", { type: "tool_running" });
		expect(text).toBe("Sober Raccoon is working on something.");
	});

	test("task_complete reads as 'finished'", () => {
		expect(formatStatusSummary("Insomniac Sloth", { type: "task_complete" })).toBe(
			"Insomniac Sloth finished.",
		);
	});

	test("failed includes the error message if present", () => {
		const text = formatStatusSummary("Burnt-Out Hummingbird", {
			type: "failed",
			data: { error: "command timed out" },
		});
		expect(text).toContain("command timed out");
		expect(text).toContain("Burnt-Out Hummingbird");
	});

	test("failed without error falls back generic", () => {
		expect(formatStatusSummary("Pessimistic Beaver", { type: "failed" })).toBe(
			"Pessimistic Beaver hit a snag.",
		);
	});

	test("login_required reads as authenticate prompt", () => {
		expect(formatStatusSummary("Newly-Divorced Stork", { type: "login_required" })).toBe(
			"Newly-Divorced Stork needs you to authenticate.",
		);
	});

	test("unknown event type falls back to '(eventType)' tail", () => {
		const text = formatStatusSummary("Lazy Weasel", { type: "weird_event" });
		expect(text).toBe("Lazy Weasel (weird_event).");
	});
});

describe("createWorkerStatusRelay", () => {
	function setupRelay(opts?: { initialTime?: number; names?: Record<string, string> }) {
		let now = opts?.initialTime ?? 1_000_000;
		const names = opts?.names ?? {};
		const relay = createWorkerStatusRelay({
			lookupWorkerName: (id) => names[id],
			now: () => now,
		});
		return {
			relay,
			tick(ms: number) {
				now += ms;
			},
			now: () => now,
		};
	}

	test("emits for session_ready", () => {
		const { relay } = setupRelay({ names: { s1: "Hungover Owl" } });
		const update = relay.relay({ type: "session_ready", sessionId: "s1" });
		expect(update).not.toBeNull();
		expect(update?.workerName).toBe("Hungover Owl");
		expect(update?.summary).toContain("Hungover Owl");
	});

	test("skips events not in the surfaced set (e.g. internal heartbeats)", () => {
		const { relay } = setupRelay({ names: { s1: "Quiet Hyena" } });
		expect(relay.relay({ type: "heartbeat", sessionId: "s1" })).toBeNull();
		expect(relay.relay({ type: "output_chunk", sessionId: "s1" })).toBeNull();
	});

	test("skips when sessionId is missing", () => {
		const { relay } = setupRelay({ names: { s1: "Lazy Weasel" } });
		expect(relay.relay({ type: "session_ready" } as RawPtySessionEvent)).toBeNull();
	});

	test("skips when no worker name is registered", () => {
		const { relay } = setupRelay({ names: {} });
		expect(relay.relay({ type: "session_ready", sessionId: "s-missing" })).toBeNull();
	});

	test("throttles tool_running to one per 5s per (sessionId, tool)", () => {
		const { relay, tick } = setupRelay({ names: { s1: "Vegan Hyena" } });
		const first = relay.relay({ type: "tool_running", sessionId: "s1", data: { tool: "read" } });
		expect(first).not.toBeNull();
		// Same tool, immediately — throttled
		const second = relay.relay({ type: "tool_running", sessionId: "s1", data: { tool: "read" } });
		expect(second).toBeNull();
		// Different tool, same session — not throttled (different key)
		const third = relay.relay({ type: "tool_running", sessionId: "s1", data: { tool: "write" } });
		expect(third).not.toBeNull();
		// After 5s, same tool can emit again
		tick(5_001);
		const fourth = relay.relay({ type: "tool_running", sessionId: "s1", data: { tool: "read" } });
		expect(fourth).not.toBeNull();
	});

	test("does not throttle non-tool events", () => {
		const { relay } = setupRelay({ names: { s1: "Insomniac Sloth" } });
		// Multiple session_ready in a row aren't throttled.
		expect(relay.relay({ type: "session_ready", sessionId: "s1" })).not.toBeNull();
		expect(relay.relay({ type: "session_ready", sessionId: "s1" })).not.toBeNull();
		expect(relay.relay({ type: "task_complete", sessionId: "s1" })).not.toBeNull();
	});

	test("attaches `tool` field when extractable", () => {
		const { relay } = setupRelay({ names: { s1: "On-Call Alpaca" } });
		const update = relay.relay({
			type: "tool_running",
			sessionId: "s1",
			tool: "bash",
		});
		expect(update?.tool).toBe("bash");
	});

	test("end-to-end: realistic event flow renders sensible chat lines", () => {
		const { relay, tick } = setupRelay({ names: { s1: "Dissociating Squirrel" } });
		const events: RawPtySessionEvent[] = [
			{ type: "spawned", sessionId: "s1" },
			{ type: "session_ready", sessionId: "s1" },
			{ type: "tool_running", sessionId: "s1", data: { tool: "read", path: "src/index.ts" } },
			// throttle kicks in here:
			{ type: "tool_running", sessionId: "s1", data: { tool: "read", path: "src/utils.ts" } },
		];
		const surfaced = events.map((e) => relay.relay(e)).filter((x): x is NonNullable<typeof x> => x !== null);
		// First three surface, fourth throttled.
		expect(surfaced).toHaveLength(3);
		expect(surfaced[0]!.summary).toContain("online and ready");
		expect(surfaced[2]!.summary).toContain("src/index.ts");
		// After throttle window, next tool call surfaces again.
		tick(5_500);
		const fifth = relay.relay({ type: "tool_running", sessionId: "s1", data: { tool: "read", path: "src/lib.ts" } });
		expect(fifth?.summary).toContain("src/lib.ts");
	});
});
