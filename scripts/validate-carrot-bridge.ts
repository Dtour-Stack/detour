/**
 * End-to-end test for the carrot bridge.
 *
 * Loads the cron-tools carrot, registers an in-memory fake CronService,
 * invokes each action's handler exactly as eliza's AgentRuntime would
 * (Plugin.actions[i].handler(runtime, message, state, options, callback)),
 * and asserts:
 *
 *   1. The carrot worker spawns and reports `ready` with the expected
 *      action manifest.
 *   2. The Plugin adapter produces a Plugin that registers all 5 cron
 *      actions with correct names + parameters.
 *   3. RPC round-trips for `service.invoke("cron", "createJob", [...])`
 *      hit the registered service handle and return its result to the
 *      action handler in the worker.
 *   4. The handler emits via `callback({text, action})` and the host
 *      receives the emit through the bridge.
 *
 * Run: bun scripts/validate-carrot-bridge.ts
 */

import { join } from "node:path";
import { CarrotManager } from "../src/bun/core/carrots/index";

interface CronJob {
	id: string;
	name: string;
	schedule: string;
	prompt: string;
	enabled: boolean;
	createdAt: number;
	createdBy: string;
	updatedAt: number;
	runCount: number;
}

function makeFakeCronService(): {
	listJobs(): CronJob[];
	getJob(id: string): CronJob | null;
	createJob(input: Partial<CronJob> & { schedule: string; prompt: string }): CronJob;
	updateJob(id: string, patch: Partial<CronJob>): CronJob | null;
	deleteJob(id: string): boolean;
} {
	const jobs = new Map<string, CronJob>();
	let nextId = 1;
	return {
		listJobs() { return [...jobs.values()]; },
		getJob(id) { return jobs.get(id) ?? null; },
		createJob(input) {
			const id = `job-${nextId++}`;
			const job: CronJob = {
				id,
				name: input.name ?? input.schedule,
				schedule: input.schedule,
				prompt: input.prompt,
				enabled: input.enabled ?? true,
				createdAt: Date.now(),
				createdBy: input.createdBy ?? "test",
				updatedAt: Date.now(),
				runCount: 0,
			};
			jobs.set(id, job);
			return job;
		},
		updateJob(id, patch) {
			const job = jobs.get(id);
			if (!job) return null;
			const next = { ...job, ...patch, updatedAt: Date.now() };
			jobs.set(id, next);
			return next;
		},
		deleteJob(id) { return jobs.delete(id); },
	};
}

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function main(): Promise<void> {
	const cm = new CarrotManager();
	const fake = makeFakeCronService();
	cm.registerService("cron", fake as unknown as Record<string, (...args: unknown[]) => unknown>);

	console.log("[test] loading cron-tools carrot");
	const plugin = await cm.loadFromDir(join(import.meta.dir, "..", "carrots", "cron-tools"));
	assert(plugin.name === "cron-tools", `plugin.name: got ${plugin.name}`);
	assert(plugin.actions?.length === 5, `actions count: got ${plugin.actions?.length}`);

	const byName = new Map(plugin.actions!.map((a) => [a.name, a]));
	for (const expected of ["CRON_CREATE", "CRON_LIST", "CRON_READ", "CRON_UPDATE", "CRON_DELETE"]) {
		assert(byName.has(expected), `missing action: ${expected}`);
	}
	console.log("[test] all 5 actions registered:", [...byName.keys()].join(", "));

	const fakeRuntime = {} as Parameters<NonNullable<typeof plugin.actions>[number]["handler"]>[0];
	const fakeMessage = { id: "m-1", entityId: "e-1", roomId: "r-1", content: { text: "test" } } as Parameters<NonNullable<typeof plugin.actions>[number]["handler"]>[1];
	const fakeState = {} as Parameters<NonNullable<typeof plugin.actions>[number]["handler"]>[2];

	// Test 1: CRON_LIST when empty
	console.log("\n[test] CRON_LIST (empty)");
	const emits1: { text: string; action: string }[] = [];
	const list1 = (await byName.get("CRON_LIST")!.handler(
		fakeRuntime, fakeMessage, fakeState, {},
		(async (p: { text: string; action: string }) => { emits1.push(p); return []; }) as never,
	)) as { success: boolean; jobs: CronJob[] };
	assert(list1.success === true, "CRON_LIST should succeed");
	assert(Array.isArray(list1.jobs), "CRON_LIST should return jobs array");
	assert(list1.jobs.length === 0, `empty list expected, got ${list1.jobs.length}`);
	assert(emits1.length === 1 && emits1[0]!.text === "No cron jobs.", `emit 1: ${JSON.stringify(emits1)}`);
	console.log("  ✓ returned empty list, emitted 'No cron jobs.'");

	// Test 2: CRON_CREATE
	console.log("\n[test] CRON_CREATE");
	const emits2: { text: string; action: string }[] = [];
	const create = (await byName.get("CRON_CREATE")!.handler(
		fakeRuntime, fakeMessage, fakeState,
		{ parameters: { schedule: "every:5m", prompt: "check inbox", name: "inbox-check" } },
		(async (p: { text: string; action: string }) => { emits2.push(p); return []; }) as never,
	)) as { success: boolean; job: CronJob };
	assert(create.success === true, `CRON_CREATE failed: ${JSON.stringify(create)}`);
	assert(create.job.schedule === "every:5m", `schedule mismatch: ${create.job.schedule}`);
	assert(create.job.prompt === "check inbox", `prompt mismatch: ${create.job.prompt}`);
	assert(create.job.name === "inbox-check", `name mismatch: ${create.job.name}`);
	assert(emits2.length === 1 && emits2[0]!.action === "CRON_CREATE", `emit 2: ${JSON.stringify(emits2)}`);
	console.log(`  ✓ created job ${create.job.id}, callback fired`);

	// Test 3: CRON_LIST again (should have 1)
	console.log("\n[test] CRON_LIST (after create)");
	const list2 = (await byName.get("CRON_LIST")!.handler(
		fakeRuntime, fakeMessage, fakeState, {},
		(async () => []) as never,
	)) as { success: boolean; jobs: CronJob[] };
	assert(list2.jobs.length === 1, `expected 1 job, got ${list2.jobs.length}`);
	assert(list2.jobs[0]!.id === create.job.id, "list should contain created job");
	console.log("  ✓ list reflects newly-created job");

	// Test 4: CRON_READ
	console.log("\n[test] CRON_READ");
	const read = (await byName.get("CRON_READ")!.handler(
		fakeRuntime, fakeMessage, fakeState,
		{ parameters: { id: create.job.id } },
		(async () => []) as never,
	)) as { success: boolean; job: CronJob };
	assert(read.success && read.job.id === create.job.id, `CRON_READ result: ${JSON.stringify(read)}`);
	console.log(`  ✓ read job ${read.job.id}`);

	// Test 5: CRON_UPDATE
	console.log("\n[test] CRON_UPDATE");
	const upd = (await byName.get("CRON_UPDATE")!.handler(
		fakeRuntime, fakeMessage, fakeState,
		{ parameters: { id: create.job.id, enabled: false } },
		(async () => []) as never,
	)) as { success: boolean; job: CronJob };
	assert(upd.success && upd.job.enabled === false, `CRON_UPDATE result: ${JSON.stringify(upd)}`);
	console.log(`  ✓ updated job ${upd.job.id} enabled=false`);

	// Test 6: missing-param fallthrough
	console.log("\n[test] CRON_CREATE missing schedule");
	const bad = (await byName.get("CRON_CREATE")!.handler(
		fakeRuntime, fakeMessage, fakeState,
		{ parameters: { prompt: "no schedule given" } },
		(async () => []) as never,
	)) as { success: boolean; error: string };
	assert(bad.success === false && bad.error?.includes("schedule"), `expected missing-schedule error: ${JSON.stringify(bad)}`);
	console.log("  ✓ rejected missing schedule with structured error");

	// Test 7: CRON_DELETE
	console.log("\n[test] CRON_DELETE");
	const del = (await byName.get("CRON_DELETE")!.handler(
		fakeRuntime, fakeMessage, fakeState,
		{ parameters: { id: create.job.id } },
		(async () => []) as never,
	)) as { success: boolean };
	assert(del.success, `CRON_DELETE failed: ${JSON.stringify(del)}`);
	const list3 = (await byName.get("CRON_LIST")!.handler(
		fakeRuntime, fakeMessage, fakeState, {},
		(async () => []) as never,
	)) as { jobs: CronJob[] };
	assert(list3.jobs.length === 0, `expected 0 after delete, got ${list3.jobs.length}`);
	console.log("  ✓ deleted job, list now empty");

	cm.stopAll();
	console.log("\n✓ all carrot bridge tests passed");
}

main().catch((err) => {
	console.error("✗ test failed:", err);
	process.exit(1);
});
