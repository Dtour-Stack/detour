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

	test("dedups identical fact hashes WITHIN a single planning call", () => {
		// Regression for the prod log spam: three messages in the same room
		// all surfaced the "Dexploarer is dev/operator" fact, the planner
		// returned three identical writes (same hash, same content, same
		// room), the DB unique constraint rejected all three, and the tick
		// logged `writeCount=3 failedCount=3` every cycle. The dedup must
		// happen inside one planning call, not just against persisted
		// hashes from previous ticks.
		const room2 = "11111111-1111-1111-1111-111111111111";
		const room3 = "22222222-2222-2222-2222-222222222222";
		const writes = planDiscordObservationWrites([
			message({
				id: "1",
				time: 10,
				text: "[Discord #a] @dEXploarer (Wed): @Detour gm dev",
				roomId,
			}),
			message({
				id: "2",
				time: 20,
				text: "[Discord #b] @dEXploarer (Wed): @Detour gm dev",
				roomId: room2,
			}),
			message({
				id: "3",
				time: 30,
				text: "[Discord #c] @dEXploarer (Wed): @Detour gm dev",
				roomId: room3,
			}),
		], {
			agentId,
			lastProcessedAt: 0,
			knownHashes: [],
		});
		// Every fact hash should appear at most once across the entire
		// returned write list.
		const factWrites = writes.filter((write) => write.input.tableName === "facts");
		const factHashes = factWrites.map((write) => write.hash);
		expect(new Set(factHashes).size).toBe(factHashes.length);
	});
});
