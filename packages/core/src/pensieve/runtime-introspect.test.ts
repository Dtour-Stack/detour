import { describe, expect, test } from "bun:test";
import { snapshotRuntime } from "./runtime-introspect";

describe("snapshotRuntime", () => {
	test("null runtime returns available=false with zeroed counts", () => {
		const snap = snapshotRuntime(null);
		expect(snap.available).toBe(false);
		expect(snap.counts.actions).toBe(0);
		expect(snap.actions).toEqual([]);
		expect(snap.plugins).toEqual([]);
	});

	test("extracts named registry items + sorts alphabetically", () => {
		const fakeRuntime = {
			agentId: "agent-uuid",
			character: { name: "TestAgent" },
			actions: [
				{ name: "VAULT_WRITE", description: "write vault" },
				{ name: "VAULT_READ", description: "read vault" },
			],
			providers: [],
			evaluators: [],
			services: new Map(),
			plugins: [{ name: "plugin-vault-tools", description: "vault" }],
		};
		const snap = snapshotRuntime(fakeRuntime as never);
		expect(snap.available).toBe(true);
		expect(snap.agentName).toBe("TestAgent");
		expect(snap.counts.actions).toBe(2);
		expect(snap.actions[0]!.name).toBe("VAULT_READ"); // sorted
		expect(snap.actions[1]!.name).toBe("VAULT_WRITE");
		expect(snap.plugins[0]!.name).toBe("plugin-vault-tools");
	});

	test("services Map is flattened to a list (regression: Service registry shape varies)", () => {
		const fakeRuntime = {
			actions: [],
			providers: [],
			evaluators: [],
			services: new Map([
				["trajectories", [{ capabilityDescription: "captures trajectories" }]],
			]),
			plugins: [],
		};
		const snap = snapshotRuntime(fakeRuntime as never);
		expect(snap.services.length).toBe(1);
		expect(snap.services[0]!.name).toBe("trajectories");
	});
});
