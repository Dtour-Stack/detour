import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	loginListAction,
	loginRevealAction,
	loginSaveAction,
	vaultDeleteAction,
	vaultListAction,
	vaultReadAction,
	vaultToolsPlugin,
	vaultWriteAction,
	setPermissionConfig,
} from "./index";

const ENV_KEYS = ["ELIZA_VAULT_AGENT_DENY", "ELIZA_VAULT_AGENT_MODE"];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const k of ENV_KEYS) {
		savedEnv[k] = process.env[k];
		delete process.env[k];
	}
	setPermissionConfig({ deny: false, mode: "read", allowedPrefixes: [], deniedPrefixes: [] });
});
afterEach(() => {
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
});

const fakeRuntime = { character: { name: "TestAgent" } } as never;

describe("vaultToolsPlugin shape", () => {
	test("exports all 7 actions", () => {
		expect(vaultToolsPlugin.actions).toBeDefined();
		const names = vaultToolsPlugin.actions!.map((a) => a.name).sort();
		expect(names).toEqual([
			"LOGIN_LIST",
			"LOGIN_REVEAL",
			"LOGIN_SAVE",
			"VAULT_DELETE",
			"VAULT_LIST",
			"VAULT_READ",
			"VAULT_WRITE",
		]);
	});

	test("each action has parameters declared (so the LLM knows what to fill)", () => {
		for (const a of [vaultReadAction, vaultWriteAction, vaultDeleteAction, vaultListAction, loginListAction, loginRevealAction, loginSaveAction]) {
			const params = (a as unknown as { parameters?: unknown[] }).parameters;
			expect(Array.isArray(params)).toBe(true);
		}
	});

	test("VAULT_WRITE declares key + value as required (regression: missing params returned 'requires key and value')", () => {
		const params = (vaultWriteAction as unknown as { parameters: Array<{ name: string; required?: boolean }> }).parameters;
		const required = params.filter((p) => p.required).map((p) => p.name).sort();
		expect(required).toEqual(["key", "value"]);
	});

	test("validate() always allows (gating happens in handler)", async () => {
		const noopMessage = {} as never;
		for (const a of [vaultReadAction, vaultWriteAction]) {
			expect(await a.validate(fakeRuntime, noopMessage)).toBe(true);
		}
	});
});

describe("action handler permission checks (no manager I/O)", () => {
	test("VAULT_READ refuses when permission denied", async () => {
		setPermissionConfig({ mode: "off" });
		const result = await vaultReadAction.handler(fakeRuntime, {} as never, undefined, { key: "GITHUB_TOKEN" });
		expect(result?.success).toBe(false);
		expect(result?.text).toMatch(/disabled|denied|off/i);
	});

	test("VAULT_WRITE refuses in read mode", async () => {
		setPermissionConfig({ mode: "read" });
		const result = await vaultWriteAction.handler(fakeRuntime, {} as never, undefined, { key: "X", value: "y" });
		expect(result?.success).toBe(false);
		expect(result?.text).toMatch(/read-only/i);
	});

	test("VAULT_WRITE refuses for system-deny keys even in read-write mode", async () => {
		setPermissionConfig({ mode: "read-write" });
		const result = await vaultWriteAction.handler(fakeRuntime, {} as never, undefined, { key: "_manager.preferences", value: "y" });
		expect(result?.success).toBe(false);
		expect(result?.text).toMatch(/deny-list/i);
	});

	test("VAULT_READ requires `key` param", async () => {
		setPermissionConfig({ mode: "read" });
		const result = await vaultReadAction.handler(fakeRuntime, {} as never, undefined, {});
		expect(result?.success).toBe(false);
		expect(result?.text).toMatch(/requires/i);
	});

	test("VAULT_WRITE requires both `key` and `value`", async () => {
		setPermissionConfig({ mode: "read-write" });
		const r1 = await vaultWriteAction.handler(fakeRuntime, {} as never, undefined, { key: "X" });
		expect(r1?.success).toBe(false);
		const r2 = await vaultWriteAction.handler(fakeRuntime, {} as never, undefined, { value: "y" });
		expect(r2?.success).toBe(false);
	});

	test("LOGIN_REVEAL rejects unsupported source", async () => {
		setPermissionConfig({ mode: "read" });
		const result = await loginRevealAction.handler(fakeRuntime, {} as never, undefined, { source: "made-up", identifier: "X" });
		expect(result?.success).toBe(false);
		expect(result?.text).toMatch(/unsupported|source/i);
	});
});
