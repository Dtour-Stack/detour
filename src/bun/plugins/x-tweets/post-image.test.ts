import { describe, expect, test } from "bun:test";
import { shouldAttachImage } from "./post-image";

describe("shouldAttachImage", () => {
	test("false when GENERATE_IMAGE is not registered", () => {
		expect(shouldAttachImage("any draft", [])).toBe(false);
	});
	test("deterministic for the same text when capability present", () => {
		const actions = [{ name: "GENERATE_IMAGE" }];
		const a = shouldAttachImage("a fixed draft about outages", actions);
		const b = shouldAttachImage("a fixed draft about outages", actions);
		expect(a).toBe(b);
	});
	test("fires on roughly a fraction of drafts, not all and not none", () => {
		const actions = [{ name: "GENERATE_IMAGE" }];
		const drafts = Array.from({ length: 50 }, (_, i) => `draft number ${i} about the news`);
		const hits = drafts.filter((d) => shouldAttachImage(d, actions)).length;
		expect(hits).toBeGreaterThan(0);
		expect(hits).toBeLessThan(drafts.length);
	});
});
