import { describe, expect, test } from "bun:test";
import { ActivityLogService } from "./log-service";

describe("ActivityLogService", () => {
	test("instantiates with default capacity + start/stop are idempotent no-ops without listener crashes", () => {
		const svc = new ActivityLogService(100);
		expect(() => svc.start()).not.toThrow();
		expect(() => svc.start()).not.toThrow(); // double-start should be safe
		expect(() => svc.stop()).not.toThrow();
		expect(() => svc.stop()).not.toThrow(); // double-stop too
	});

	test("list returns empty array when nothing has been written", () => {
		const svc = new ActivityLogService(10);
		expect(svc.list()).toEqual([]);
	});

	test("clear() empties the buffer", () => {
		const svc = new ActivityLogService(10);
		svc.clear();
		expect(svc.list()).toEqual([]);
	});
});
