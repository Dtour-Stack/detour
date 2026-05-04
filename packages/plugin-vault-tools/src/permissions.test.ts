import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { check, getPermissionConfig, setPermissionConfig } from "./permissions";

const ENV_KEYS = [
	"ELIZA_VAULT_AGENT_DENY",
	"ELIZA_VAULT_AGENT_MODE",
	"ELIZA_VAULT_AGENT_ALLOWED_KEYS",
	"ELIZA_VAULT_AGENT_DENIED_KEYS",
];
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

describe("permissions.check()", () => {
	test("default mode (read) allows reads + lists", () => {
		expect(check({ action: "read", target: "MY_KEY" }).allowed).toBe(true);
		expect(check({ action: "list" }).allowed).toBe(true);
	});

	test("default mode (read) denies writes + deletes", () => {
		expect(check({ action: "write", target: "MY_KEY" }).allowed).toBe(false);
		expect(check({ action: "delete", target: "MY_KEY" }).allowed).toBe(false);
	});

	test("read-write mode allows everything", () => {
		setPermissionConfig({ mode: "read-write" });
		expect(check({ action: "write", target: "MY_KEY" }).allowed).toBe(true);
		expect(check({ action: "delete", target: "MY_KEY" }).allowed).toBe(true);
	});

	test("off mode denies everything", () => {
		setPermissionConfig({ mode: "off" });
		expect(check({ action: "read", target: "MY_KEY" }).allowed).toBe(false);
		expect(check({ action: "list" }).allowed).toBe(false);
		expect(check({ action: "write", target: "MY_KEY" }).allowed).toBe(false);
	});

	test("deny=true is hard kill switch (overrides read-write)", () => {
		setPermissionConfig({ mode: "read-write", deny: true });
		expect(check({ action: "read", target: "MY_KEY" }).allowed).toBe(false);
	});

	test("system-internal prefixes always denied (regression: agent must not touch _manager.* / pm.*)", () => {
		setPermissionConfig({ mode: "read-write" });
		const denied = ["_manager.preferences", "_meta.GITHUB_TOKEN", "_routing.config", "pm.1password.session", "config.agent", "ui.theme"];
		for (const key of denied) {
			const r = check({ action: "read", target: key });
			expect(r.allowed).toBe(false);
			expect(r.reason).toMatch(/deny-list/);
		}
	});

	test("custom deny-list applies on top of defaults", () => {
		setPermissionConfig({ mode: "read-write", deniedPrefixes: ["EVM_PRIVATE", "SOLANA_"] });
		expect(check({ action: "read", target: "EVM_PRIVATE_KEY" }).allowed).toBe(false);
		expect(check({ action: "read", target: "SOLANA_PRIVATE_KEY" }).allowed).toBe(false);
		expect(check({ action: "read", target: "GITHUB_TOKEN" }).allowed).toBe(true);
	});

	test("allow-list, when set, is exclusive (only matching prefixes)", () => {
		setPermissionConfig({ mode: "read", allowedPrefixes: ["GITHUB_", "agent."] });
		expect(check({ action: "read", target: "GITHUB_TOKEN" }).allowed).toBe(true);
		expect(check({ action: "read", target: "agent.dizzy.wallet.evm" }).allowed).toBe(true);
		const r = check({ action: "read", target: "ANTHROPIC_API_KEY" });
		expect(r.allowed).toBe(false);
		expect(r.reason).toMatch(/allow-list/);
	});

	test("deny-list always wins over allow-list", () => {
		setPermissionConfig({ mode: "read-write", allowedPrefixes: ["GITHUB_"], deniedPrefixes: ["GITHUB_TOKEN"] });
		expect(check({ action: "read", target: "GITHUB_TOKEN" }).allowed).toBe(false);
	});

	test("env override: ELIZA_VAULT_AGENT_DENY=1 forces off", () => {
		setPermissionConfig({ mode: "read-write" });
		process.env.ELIZA_VAULT_AGENT_DENY = "1";
		expect(check({ action: "read", target: "MY_KEY" }).allowed).toBe(false);
	});

	test("env override: ELIZA_VAULT_AGENT_MODE wins over config", () => {
		setPermissionConfig({ mode: "off" });
		process.env.ELIZA_VAULT_AGENT_MODE = "read-write";
		expect(check({ action: "write", target: "MY_KEY" }).allowed).toBe(true);
	});

	test("env override: invalid mode value falls back to config", () => {
		setPermissionConfig({ mode: "off" });
		process.env.ELIZA_VAULT_AGENT_MODE = "invalid";
		expect(check({ action: "read", target: "MY_KEY" }).allowed).toBe(false);
	});

	test("env override: allow-list when env set ignores config allow-list", () => {
		setPermissionConfig({ mode: "read", allowedPrefixes: ["GITHUB_"] });
		process.env.ELIZA_VAULT_AGENT_ALLOWED_KEYS = "ANTHROPIC_";
		expect(check({ action: "read", target: "GITHUB_TOKEN" }).allowed).toBe(false);
		expect(check({ action: "read", target: "ANTHROPIC_API_KEY" }).allowed).toBe(true);
	});

	test("env override: deny-list ADDS to defaults + config", () => {
		setPermissionConfig({ mode: "read-write", deniedPrefixes: ["FOO_"] });
		process.env.ELIZA_VAULT_AGENT_DENIED_KEYS = "BAR_";
		expect(check({ action: "read", target: "FOO_X" }).allowed).toBe(false);
		expect(check({ action: "read", target: "BAR_X" }).allowed).toBe(false);
		expect(check({ action: "read", target: "_manager.foo" }).allowed).toBe(false); // default deny still active
	});

	test("getPermissionConfig returns current snapshot", () => {
		setPermissionConfig({ mode: "read-write", deniedPrefixes: ["X_"] });
		const cfg = getPermissionConfig();
		expect(cfg.mode).toBe("read-write");
		expect(cfg.deniedPrefixes).toEqual(["X_"]);
	});
});
