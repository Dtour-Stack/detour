import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelGatewayService } from "./gateway";

function withStateDir<T>(run: (dir: string) => T): T {
	const previous = process.env.ELIZA_STATE_DIR;
	const dir = mkdtempSync(join(tmpdir(), "detour-gateway-"));
	process.env.ELIZA_STATE_DIR = dir;
	try {
		return run(dir);
	} finally {
		if (previous === undefined) delete process.env.ELIZA_STATE_DIR;
		else process.env.ELIZA_STATE_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
}

function writeGatewayLog(dir: string): void {
	const gatewayDir = join(dir, "gateway");
	mkdirSync(gatewayDir, { recursive: true });
	writeFileSync(join(gatewayDir, "messages.jsonl"), [
		JSON.stringify({
			id: "discord-1",
			time: 1,
			direction: "in",
			channel: "discord",
			source: "discord",
			roomId: "room-1",
			entityId: "user-1",
			externalHandle: "handle-1",
			text: "first persisted discord message",
		}),
		JSON.stringify({
			id: "telegram-1",
			time: 2,
			direction: "in",
			channel: "telegram",
			source: "telegram",
			roomId: "room-2",
			entityId: "user-2",
			text: "not discord",
		}),
		JSON.stringify({
			id: "discord-2",
			time: 3,
			direction: "out",
			channel: "discord",
			source: "discord",
			roomId: "room-1",
			entityId: "agent",
			text: "second persisted discord message",
		}),
	].join("\n"));
}

describe("ChannelGatewayService", () => {
	test("list includes persisted gateway messages after restart", () => {
		withStateDir((dir) => {
			writeGatewayLog(dir);
			const service = new ChannelGatewayService();

			const result = service.list({ channel: "discord", limit: 10 });

			expect(result.total).toBe(2);
			expect(result.messages.map((message) => message.id)).toEqual(["discord-1", "discord-2"]);
		});
	});
});
