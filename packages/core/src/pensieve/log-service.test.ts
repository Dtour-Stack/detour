import { describe, expect, test } from "bun:test";
import { PensieveLogService } from "./log-service";

describe("PensieveLogService", () => {
	test("instantiates with default capacity + start/stop are idempotent no-ops without listener crashes", () => {
		const svc = new PensieveLogService(100);
		expect(() => svc.start()).not.toThrow();
		expect(() => svc.start()).not.toThrow(); // double-start should be safe
		expect(() => svc.stop()).not.toThrow();
		expect(() => svc.stop()).not.toThrow(); // double-stop too
	});

	test("list returns empty array when nothing has been written", () => {
		const svc = new PensieveLogService(10);
		expect(svc.list()).toEqual([]);
	});

	test("clear() empties the buffer", () => {
		const svc = new PensieveLogService(10);
		svc.clear();
		expect(svc.list()).toEqual([]);
	});
});
