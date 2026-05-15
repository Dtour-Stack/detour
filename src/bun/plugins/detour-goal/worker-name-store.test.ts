import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	allWorkerNames,
	lookupWorkerName,
	readStore,
	recordWorkerName,
	writeStore,
} from "./worker-name-store";

describe("worker-name-store", () => {
	let dir: string;
	let path: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "detour-worker-names-"));
		path = join(dir, "worker-names.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("returns empty state when file is missing", () => {
		const state = readStore(path);
		expect(state.version).toBe(1);
		expect(Object.keys(state.entries)).toEqual([]);
	});

	test("recordWorkerName writes + lookupWorkerName reads", () => {
		recordWorkerName("CREATE_TASK:m-1", { name: "Hungover Owl", generatedAt: 100 }, path);
		const found = lookupWorkerName("CREATE_TASK:m-1", path);
		expect(found?.name).toBe("Hungover Owl");
		expect(found?.generatedAt).toBe(100);
	});

	test("multiple records persist independently", () => {
		recordWorkerName("a", { name: "Lazy Weasel", generatedAt: 1, action: "CREATE_TASK" }, path);
		recordWorkerName("b", { name: "Tax-Evading Capybara", generatedAt: 2 }, path);
		recordWorkerName("c", { name: "Insomniac Sloth", generatedAt: 3 }, path);
		const all = allWorkerNames(path);
		expect(Object.keys(all).sort()).toEqual(["a", "b", "c"]);
		expect(all.a!.action).toBe("CREATE_TASK");
	});

	test("re-record on same key updates the value", () => {
		recordWorkerName("k", { name: "Old", generatedAt: 1 }, path);
		recordWorkerName("k", { name: "New", generatedAt: 2 }, path);
		expect(lookupWorkerName("k", path)?.name).toBe("New");
	});

	test("survives writeStore → readStore round-trip", () => {
		writeStore(
			{
				version: 1,
				entries: {
					"k1": { name: "Polyamorous Stork", generatedAt: 10 },
					"k2": { name: "Heartbroken Hippo", generatedAt: 20 },
				},
			},
			path,
		);
		const back = readStore(path);
		expect(back.entries.k1!.name).toBe("Polyamorous Stork");
		expect(back.entries.k2!.name).toBe("Heartbroken Hippo");
	});

	test("returns empty state on corrupt JSON instead of throwing", () => {
		// Simulate corruption by writing junk to the file.
		writeStore({ version: 1, entries: {} }, path);
		// Now mess it up.
		const fs = require("node:fs") as typeof import("node:fs");
		fs.writeFileSync(path, "{not valid json", "utf8");
		const state = readStore(path);
		expect(state.entries).toEqual({});
	});

	test("returns empty state on wrong-version file", () => {
		const fs = require("node:fs") as typeof import("node:fs");
		fs.writeFileSync(path, JSON.stringify({ version: 2, entries: { x: { name: "Future" } } }), "utf8");
		expect(readStore(path).entries).toEqual({});
	});

	test("file is written with 0600 mode (private to user)", () => {
		recordWorkerName("priv", { name: "Sober Raccoon", generatedAt: 1 }, path);
		const fs = require("node:fs") as typeof import("node:fs");
		const stat = fs.statSync(path);
		// 0o600 = owner read/write only. Mask to file-perm bits.
		expect(stat.mode & 0o777).toBe(0o600);
	});
});
