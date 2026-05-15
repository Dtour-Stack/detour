/**
 * Integration test for the inbox → agent bridge — the "key invariant"
 * called out in CLAUDE.md: notifications, agent observations, and
 * channel signals all drive the agent through the SAME
 * messageService.handleMessage pipeline as chat, not a shortcut.
 *
 * Audit (docs/testing-audit.md) flagged this as zero-coverage.
 * This test wires an InboxService against a real AgentRuntime + minimal
 * RuntimeService/ChannelGatewayService shims, posts an inbox item with
 * prompt:true, and asserts handleMessage runs end-to-end.
 *
 * It runs in a private state dir so the test doesn't disturb the user's
 * real ~/.detour/inbox/items.jsonl.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AgentRuntime,
	ModelType,
	stringToUuid,
	type GenerateTextParams,
	type IAgentRuntime,
	type Plugin,
	type TextStreamResult,
} from "@elizaos/core";
import { InboxService } from "./index";
import type { RuntimeService } from "../runtime";
import type { ChannelGatewayService } from "../channels/gateway";

// Isolate from the user's real state dir. ELIZA_STATE_DIR is read by
// resolveStateDir() inside the inbox module to pick where to write
// items.jsonl. Set BEFORE construction.
let tempStateDir: string;
const origStateDir = process.env.ELIZA_STATE_DIR;

beforeAll(() => {
	tempStateDir = mkdtempSync(join(tmpdir(), "detour-inbox-test-"));
	process.env.ELIZA_STATE_DIR = tempStateDir;
});

afterAll(() => {
	if (tempStateDir) {
		try {
			rmSync(tempStateDir, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
	if (origStateDir === undefined) {
		delete process.env.ELIZA_STATE_DIR;
	} else {
		process.env.ELIZA_STATE_DIR = origStateDir;
	}
});

const builtRuntimes: AgentRuntime[] = [];

afterEach(async () => {
	while (builtRuntimes.length > 0) {
		const rt = builtRuntimes.pop();
		try {
			await rt?.stop();
		} catch {
			/* best-effort */
		}
	}
});

function makeTextPlugin(name: string, response: string): Plugin {
	return {
		name,
		description: `${name} test plugin`,
		models: {
			[ModelType.TEXT_LARGE]: (async (
				_runtime: IAgentRuntime,
				_params: GenerateTextParams,
			): Promise<string | TextStreamResult> => response) as never,
			[ModelType.TEXT_SMALL]: (async (
				_runtime: IAgentRuntime,
				_params: GenerateTextParams,
			): Promise<string | TextStreamResult> => response) as never,
			[ModelType.TEXT_EMBEDDING]: (async (
				_runtime: IAgentRuntime,
				_params: unknown,
			): Promise<number[]> => new Array(384).fill(0)) as never,
		},
	};
}

async function buildRuntime(textResponse: string): Promise<AgentRuntime> {
	const runtime = new AgentRuntime({
		agentId: stringToUuid("inbox-integration-agent"),
		character: { name: "InboxProbe", bio: ["probe"] },
		plugins: [makeTextPlugin("text-stub", textResponse)],
		settings: { ALLOW_NO_DATABASE: "true" },
	});
	await runtime.initialize({ allowNoDatabase: true });
	builtRuntimes.push(runtime);
	return runtime;
}

interface CapturedGatewayCall {
	text: string;
	roomId: string;
	entityId: string;
	channel: string;
	source: string;
}

function makeStubGateway(): {
	calls: CapturedGatewayCall[];
	service: ChannelGatewayService;
} {
	const calls: CapturedGatewayCall[] = [];
	const stub = {
		recordChatReply: (opts: CapturedGatewayCall) => {
			calls.push(opts);
		},
		attach: () => {
			/* no-op */
		},
		stop: () => {
			/* no-op */
		},
	};
	return {
		calls,
		service: stub as unknown as ChannelGatewayService,
	};
}

function makeStubRuntimeService(runtime: AgentRuntime): RuntimeService {
	const stub = {
		peek: () => runtime,
		getOrBuild: async () => ({ runtime, provider: "test" }),
		setGateway: () => {
			/* no-op */
		},
		setOwnerBind: () => {
			/* no-op */
		},
		onAfterBuild: () => {
			/* no-op */
		},
	};
	return stub as unknown as RuntimeService;
}

describe("InboxService → agent handleMessage bridge", () => {
	test("post() with prompt:true delivers the message into runtime.messageService", async () => {
		const cannedReply = `<response>
	<thought>responding to inbox notification</thought>
	<actions>REPLY</actions>
	<text>got it</text>
</response>`;
		const runtime = await buildRuntime(cannedReply);

		// Spy on handleMessage so we can confirm the inbox path actually
		// reaches eliza's message pipeline — not a shortcut.
		const originalHandle = runtime.messageService!.handleMessage.bind(runtime.messageService!);
		let handleCalls = 0;
		runtime.messageService!.handleMessage = (async (...args: Parameters<typeof originalHandle>) => {
			handleCalls += 1;
			return originalHandle(...args);
		}) as typeof originalHandle;

		const { service: gateway, calls: gatewayCalls } = makeStubGateway();
		const inbox = new InboxService(makeStubRuntimeService(runtime), gateway);

		const item = await inbox.post({
			kind: "task",
			title: "test notification",
			body: "please acknowledge",
			source: "test:integration",
			prompt: true,
		});

		expect(item.kind).toBe("task");
		expect(item.title).toBe("test notification");

		// promptAgent is fire-and-forget; give it a beat to run the
		// handleMessage pipeline. The runtime's text-large stub returns
		// instantly so this is bounded.
		await new Promise((r) => setTimeout(r, 500));

		// The headline invariant: handleMessage was called.
		expect(handleCalls).toBeGreaterThan(0);

		// Gateway should receive the reply (if any text came back from
		// the planner). We don't require it — depending on planner
		// nondeterminism the reply may be empty — but if there IS a
		// reply, it must be routed.
		for (const call of gatewayCalls) {
			expect(call.source.startsWith("inbox:")).toBe(true);
			expect(call.channel).toBe("chat");
		}
	});

	test("post() with prompt:false does NOT trigger handleMessage (record-only path)", async () => {
		const runtime = await buildRuntime("ignored");
		let handleCalls = 0;
		const originalHandle = runtime.messageService!.handleMessage.bind(runtime.messageService!);
		runtime.messageService!.handleMessage = (async (...args: Parameters<typeof originalHandle>) => {
			handleCalls += 1;
			return originalHandle(...args);
		}) as typeof originalHandle;

		const { service: gateway } = makeStubGateway();
		const inbox = new InboxService(makeStubRuntimeService(runtime), gateway);

		await inbox.post({
			kind: "event",
			title: "record-only event",
			body: "no agent action",
			source: "test:silent",
			prompt: false,
		});

		await new Promise((r) => setTimeout(r, 200));
		expect(handleCalls).toBe(0);
	});

	test("dedupeBySource skips a second prompt while the first is still acting", async () => {
		// Per inbox/index.ts:69-87 — dedupeBySource prevents stacking
		// when periodic posters (cron, channels) fire faster than the
		// agent acts. Real bug we observed (200+ pending items from one
		// stuck cron). Test it.
		const slowReply = `<response>
	<thought>slow ack</thought>
	<actions>REPLY</actions>
	<text>ok</text>
</response>`;
		const runtime = await buildRuntime(slowReply);
		// Make handleMessage block for a while so the second post arrives
		// while the first is still in flight.
		runtime.messageService!.handleMessage = (async () => {
			await new Promise((r) => setTimeout(r, 250));
			return [];
		}) as unknown as NonNullable<typeof runtime.messageService>["handleMessage"];

		const { service: gateway } = makeStubGateway();
		const inbox = new InboxService(makeStubRuntimeService(runtime), gateway);

		const first = await inbox.post({
			kind: "task",
			title: "cron tick",
			body: "tick 1",
			source: "cron:demo",
			prompt: true,
			dedupeBySource: true,
		});
		const second = await inbox.post({
			kind: "task",
			title: "cron tick",
			body: "tick 2",
			source: "cron:demo",
			prompt: true,
			dedupeBySource: true,
		});

		// Dedupe contract per the source code: when the first item is
		// still `acting`, the second post is SKIPPED entirely and the
		// SAME inbox item is returned.
		expect(second.id).toBe(first.id);
	});
});
