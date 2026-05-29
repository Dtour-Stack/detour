import { describe, expect, test, afterEach } from "bun:test";
import { buildResearchContext } from "./research";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("buildResearchContext", () => {
	test("returns formatted live results when a key is present", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ results: [
				{ title: "Big outage today", content: "a config change took down a region", url: "https://x.test/1" },
			] }), { status: 200 })) as typeof fetch;
		const ctx = await buildResearchContext("the outage", "tvly-test");
		expect(ctx).toContain("Big outage today");
		expect(ctx).toContain("config change");
	});

	test("returns empty string and does not throw when no key", async () => {
		const ctx = await buildResearchContext("anything", "");
		expect(ctx).toBe("");
	});
});
