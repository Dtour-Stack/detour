import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelGatewayService } from "../channels/gateway";
import type { RuntimeService } from "../runtime";
import { InboxService } from "./index";

/**
 * Tests for source-based dedup in InboxService.post().
 *
 * Why: a cron job that ticks every 5-10 minutes was spawning hundreds
 * of identical pending inbox items whenever the agent couldn't service
 * them quickly (model 429, network blip). dedupeBySource gives the
 * caller "if there's already a live item with this source, reuse it"
 * semantics so the inbox doesn't accumulate junk.
 */

function makeRuntimeService(): RuntimeService {
	return {
		peek: () => null,
		onAfterBuild: () => undefined,
	} as unknown as RuntimeService;
}

function makeGateway(): ChannelGatewayService {
	return {
		recordChatReply: () => undefined,
		identityCandidates: () => [],
	} as unknown as ChannelGatewayService;
}

describe("InboxService.post() — dedupeBySource", () => {
	let stateDir: string;
	let inbox: InboxService;

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), "detour-inbox-test-"));
		process.env.ELIZA_STATE_DIR = stateDir;
		inbox = new InboxService(makeRuntimeService(), makeGateway());
	});

	afterEach(() => {
		rmSync(stateDir, { recursive: true, force: true });
		delete process.env.ELIZA_STATE_DIR;
	});

	test("baseline: without dedupeBySource, each post creates a new item", async () => {
		const a = await inbox.post({
			kind: "task",
			title: "[cron] test",
			body: "do thing",
			source: "cron:abc",
			prompt: false,
		});
		const b = await inbox.post({
			kind: "task",
			title: "[cron] test",
			body: "do thing",
			source: "cron:abc",
			prompt: false,
		});
		expect(a.id).not.toBe(b.id);
		expect(inbox.list({ source: "cron:abc" }).total).toBe(2);
	});

	test("dedupeBySource: pending duplicate is refreshed, not stacked", async () => {
		const first = await inbox.post({
			kind: "task",
			title: "[cron] tick 1",
			body: "first body",
			source: "cron:abc",
			prompt: false,
			dedupeBySource: true,
		});
		// promptAgent bails out (runtime peek returns null) so the first
		// item stays in its initial "pending" state — perfect for testing
		// the refresh path.
		expect(first.status).toBe("pending");

		// Spin enough that the timestamps would differ even without dedupe.
		await new Promise((r) => setTimeout(r, 5));

		const second = await inbox.post({
			kind: "task",
			title: "[cron] tick 2",
			body: "second body — should overwrite",
			source: "cron:abc",
			prompt: false,
			dedupeBySource: true,
		});

		expect(second.id).toBe(first.id);
		expect(second.body).toBe("second body — should overwrite");
		expect(second.title).toBe("[cron] tick 2");
		expect(second.time).toBeGreaterThan(first.time);

		// Buffer holds exactly one item with this source.
		const list = inbox.list({ source: "cron:abc" });
		expect(list.total).toBe(1);
		expect(list.items[0]!.body).toBe("second body — should overwrite");
	});

	test("dedupeBySource: acting duplicate is skipped (returned untouched)", async () => {
		const first = await inbox.post({
			kind: "task",
			title: "[cron] tick 1",
			body: "first body",
			source: "cron:abc",
			prompt: false,
			dedupeBySource: true,
		});
		// Force the first item into the acting state — simulates an
		// in-flight agent prompt.
		inbox.updateStatus(first.id, "acting");

		const second = await inbox.post({
			kind: "task",
			title: "[cron] tick 2",
			body: "second body — should be ignored",
			source: "cron:abc",
			prompt: false,
			dedupeBySource: true,
		});

		expect(second.id).toBe(first.id);
		// Body NOT overwritten because the item is acting — we just skip.
		expect(second.body).toBe("first body");
		expect(inbox.list({ source: "cron:abc" }).total).toBe(1);
	});

	test("dedupeBySource: a terminal item does not block a fresh post", async () => {
		const first = await inbox.post({
			kind: "task",
			title: "[cron] tick 1",
			body: "first body",
			source: "cron:abc",
			prompt: false,
			dedupeBySource: true,
		});
		inbox.updateStatus(first.id, "acted");

		const second = await inbox.post({
			kind: "task",
			title: "[cron] tick 2",
			body: "second body",
			source: "cron:abc",
			prompt: false,
			dedupeBySource: true,
		});

		expect(second.id).not.toBe(first.id);
		expect(inbox.list({ source: "cron:abc" }).total).toBe(2);
	});

	test("dedupeBySource: different sources don't collide", async () => {
		const a = await inbox.post({
			kind: "task",
			title: "[cron] A",
			body: "A body",
			source: "cron:a",
			prompt: false,
			dedupeBySource: true,
		});
		const b = await inbox.post({
			kind: "task",
			title: "[cron] B",
			body: "B body",
			source: "cron:b",
			prompt: false,
			dedupeBySource: true,
		});
		expect(a.id).not.toBe(b.id);
		expect(inbox.list({ source: "cron:a" }).total).toBe(1);
		expect(inbox.list({ source: "cron:b" }).total).toBe(1);
	});

	test("simulates the prod loop: 100 ticks from the same cron stay at 1 inbox row", async () => {
		const ids = new Set<string>();
		for (let i = 0; i < 100; i += 1) {
			const item = await inbox.post({
				kind: "task",
				title: "[cron] x mentions",
				body: `tick ${i}`,
				source: "cron:loop-job",
				prompt: false,
				dedupeBySource: true,
			});
			ids.add(item.id);
		}
		expect(ids.size).toBe(1); // all 100 ticks collapsed onto one row
		const list = inbox.list({ source: "cron:loop-job" });
		expect(list.total).toBe(1);
		expect(list.items[0]!.body).toBe("tick 99"); // last write wins
	});
});
