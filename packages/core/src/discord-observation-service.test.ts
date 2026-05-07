import { describe, expect, test } from "bun:test";
import { planDiscordObservationWrites } from "./discord-observation-service";
import type { GatewayMessage } from "./channels/gateway";

const agentId = "0b0d99a5-666d-0f9f-9c12-3c0022b95db3";
const roomId = "cdfea3ca-9b95-0125-8155-dc4308f7f806";
const dexploarerId = "c2269992-d475-04ad-ab68-7dff9209c695";

function message(input: Partial<GatewayMessage> & { id: string; time: number; text: string }): GatewayMessage {
	return {
		direction: "in",
		channel: "discord",
		source: "discord",
		roomId,
		entityId: dexploarerId,
		externalHandle: "458148462639316993",
		...input,
	};
}

describe("Discord observation service", () => {
	test("plans room notes and durable facts from Discord history", () => {
		const writes = planDiscordObservationWrites([
			message({
				id: "1",
				time: 1,
				text: "[Discord #cozy] @dEXploarer (Wed): @Detour any fud on X lately?",
			}),
			message({
				id: "2",
				time: 2,
				text: "[Discord #cozy] @dEXploarer (Wed): @Detour i was specifically asking about in your notifications",
			}),
		], {
			agentId,
			lastProcessedAt: 0,
			knownHashes: [],
		});

		expect(writes.length).toBe(3);
		expect(writes[0]?.input.tableName).toBeUndefined();
		expect(writes[0]?.input.path).toBe(`/discord/rooms/${roomId}/observations`);
		expect(writes[0]?.input.text).toContain("inspect Detour's own X notifications");
		const facts = writes.filter((write) => write.input.tableName === "facts");
		expect(facts.map((write) => write.input.text)).toContain("Dexploarer is Detour's dev/operator and trusted builder context in Discord.");
		expect(facts.map((write) => write.input.text)).toContain("Dexploarer expects Detour to inspect its own X notifications when asked about X FUD, tags, or mentions.");
	});

	test("does not repeat writes for known hashes", () => {
		const first = planDiscordObservationWrites([
			message({
				id: "1",
				time: 1,
				text: "[Discord #cozy] @dEXploarer (Wed): botdick is your dev? damnnn",
			}),
		], {
			agentId,
			lastProcessedAt: 0,
			knownHashes: [],
		});
		const second = planDiscordObservationWrites([
			message({
				id: "1",
				time: 1,
				text: "[Discord #cozy] @dEXploarer (Wed): botdick is your dev? damnnn",
			}),
		], {
			agentId,
			lastProcessedAt: 0,
			knownHashes: first.map((write) => write.hash),
		});

		expect(second).toEqual([]);
	});
});
