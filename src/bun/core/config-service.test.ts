import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConfigService } from "./config-service";
import type { VaultService } from "./vault";
import { setPermissionConfig, getPermissionConfig } from "../plugins/vault-tools/index";

/**
 * Tests use an in-memory fake vault that mirrors the SecretsManager / Vault
 * surface ConfigService consumes (`vault.has`, `vault.get`, `vault.set`).
 */
function makeFakeVaultService(initial: Record<string, string> = {}): VaultService {
	const store = new Map(Object.entries(initial));
	const vault = {
		has: async (k: string) => store.has(k),
		get: async (k: string) => store.get(k) ?? "",
		set: async (k: string, v: string) => {
			store.set(k, v);
		},
		remove: async (k: string) => {
			store.delete(k);
		},
		list: async () => Array.from(store.keys()),
	};
	return { vault: async () => vault } as unknown as VaultService;
}

const ENV_KEYS = ["CODEX_MODEL_LARGE", "CODEX_MODEL_SMALL", "CODEX_MODEL_IMAGE", "ELIZA_VAULT_AGENT_DENY", "ELIZA_VAULT_AGENT_MODE"];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const k of ENV_KEYS) {
		savedEnv[k] = process.env[k];
		delete process.env[k];
	}
});
afterEach(() => {
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
});

describe("ConfigService", () => {
	test("getAgent returns sane defaults when unset", async () => {
		const svc = new ConfigService(makeFakeVaultService());
		const agent = await svc.getAgent();
		expect(agent.deny).toBe(false);
		expect(agent.mode).toBe("read");
		expect(agent.allowedPrefixes).toEqual([]);
		expect(agent.deniedPrefixes).toEqual([]);
	});

	test("setAgent → getAgent JSON round-trip", async () => {
		const svc = new ConfigService(makeFakeVaultService());
		await svc.setAgent({
			deny: false,
			mode: "read-write",
			allowedPrefixes: ["GITHUB_", "agent."],
			deniedPrefixes: ["EVM_"],
		});
		const got = await svc.getAgent();
		expect(got.mode).toBe("read-write");
		expect(got.allowedPrefixes).toEqual(["GITHUB_", "agent."]);
		expect(got.deniedPrefixes).toEqual(["EVM_"]);
	});

	test("setAgent applies snapshot to permission gate (regression: UI toggle must take effect immediately)", async () => {
		const svc = new ConfigService(makeFakeVaultService());
		await svc.setAgent({ deny: false, mode: "read-write", allowedPrefixes: [], deniedPrefixes: [] });
		expect(getPermissionConfig().mode).toBe("read-write");
		// Restore for downstream tests
		setPermissionConfig({ mode: "read", deny: false, allowedPrefixes: [], deniedPrefixes: [] });
	});

	test("getAgent sanitizes invalid mode to 'read' (regression: bad config can't escalate)", async () => {
		const svc = new ConfigService(makeFakeVaultService({
			"config.agent": JSON.stringify({ deny: false, mode: "ROOT", allowedPrefixes: [], deniedPrefixes: [] }),
		}));
		const got = await svc.getAgent();
		expect(got.mode).toBe("read");
	});

	test("getModels defaults are gpt-5.2 across buckets", async () => {
		const svc = new ConfigService(makeFakeVaultService());
		const m = await svc.getModels();
		expect(m.codexLarge).toBe("gpt-5.2");
		expect(m.codexSmall).toBe("gpt-5.2");
		expect(m.codexImage).toBe("gpt-5.2");
		expect(m.openRouterTextLarge).toBe("openrouter/free");
		expect(m.providerPriority).toEqual(["openai", "anthropic", "openrouter", "elizacloud"]);
	});

	test("setModels applies env vars so plugin-codex picks them up", async () => {
		const svc = new ConfigService(makeFakeVaultService());
		await svc.setModels({
			codexLarge: "gpt-5.5",
			codexSmall: "gpt-5.4-mini",
			codexImage: "gpt-5.5",
			openRouterTextLarge: "openrouter/free",
			openRouterTextSmall: "openrouter/free",
			openRouterEmbedding: "openai/text-embedding-3-small",
			openRouterImage: "google/gemini-2.5-flash-image",
			openRouterVision: "openrouter/free",
			elizaCloudLarge: "",
			elizaCloudMedium: "",
			elizaCloudSmall: "",
			elizaCloudNano: "",
			elizaCloudMega: "",
			elizaCloudResponseHandler: "",
			providerPriority: ["openai", "anthropic", "openrouter", "elizacloud"],
		});
		expect(process.env.CODEX_MODEL_LARGE).toBe("gpt-5.5");
		expect(process.env.CODEX_MODEL_SMALL).toBe("gpt-5.4-mini");
		expect(process.env.CODEX_MODEL_IMAGE).toBe("gpt-5.5");
		expect(process.env.OPENROUTER_MODEL_TEXT_LARGE).toBe("openrouter/free");
	});

	test("getWindow defaults match the popup's launch size", async () => {
		const svc = new ConfigService(makeFakeVaultService());
		const w = await svc.getWindow();
		expect(w.width).toBe(480);
		expect(w.height).toBe(720);
		expect(w.hideOnBlur).toBe(false);
		expect(w.alwaysOnTop).toBe(true);
	});

	test("bootstrap() applies persisted agent + models config", async () => {
		const svc = new ConfigService(makeFakeVaultService({
			"config.agent": JSON.stringify({ deny: false, mode: "off", allowedPrefixes: [], deniedPrefixes: [] }),
			"config.models": JSON.stringify({
				codexLarge: "gpt-5.5",
				codexSmall: "gpt-5.5",
				codexImage: "gpt-5.5",
				providerPriority: ["openai-codex"],
			}),
		}));
		await svc.bootstrap();
		expect(getPermissionConfig().mode).toBe("off");
		expect(process.env.CODEX_MODEL_LARGE).toBe("gpt-5.5");
		expect((await svc.getModels()).providerPriority).toEqual(["openai", "anthropic", "openrouter"]);
		setPermissionConfig({ mode: "read", deny: false, allowedPrefixes: [], deniedPrefixes: [] });
	});

	test("malformed JSON in config.agent falls back to defaults instead of crashing", async () => {
		const svc = new ConfigService(makeFakeVaultService({ "config.agent": "{not-json" }));
		const a = await svc.getAgent();
		expect(a.mode).toBe("read");
	});
});
