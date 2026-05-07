// Thin re-exports + LLM-provider helpers. Most callers should use
// `manager` / `vault` directly instead of going through this file —
// the @elizaos/vault API is rich and we don't want to filter it.

import {
	createManager,
	createVault,
	listVaultInventory,
	categorizeKey,
	inferProviderId,
	readEntryMeta,
	setEntryMeta,
	removeEntryMeta,
	readRoutingConfig,
	writeRoutingConfig,
	BACKEND_INSTALL_SPECS,
	buildInstallCommand,
	currentPlatform,
	detectPackageManagers,
	resolveRunnableMethods,
	getSavedLogin,
	setSavedLogin,
	listSavedLogins,
	deleteSavedLogin,
	setAutofillAllowed,
	getAutofillAllowed,
	type BackendId,
	type BackendInstallSpec,
	type RoutingConfig,
	type SavedLogin,
	type SecretsManager,
	type SupportedPlatform,
	type VaultEntryMeta,
} from "@elizaos/vault";
import type { ProviderId, ProviderInfo } from "@detour/shared";
import { securityCliMasterKey } from "./master-key-security-cli";

const PROVIDERS: ReadonlyArray<{
	id: ProviderId;
	label: string;
	envKey: string;
}> = [
	{ id: "anthropic", label: "Anthropic (Claude)", envKey: "ANTHROPIC_API_KEY" },
	{ id: "openai", label: "OpenAI", envKey: "OPENAI_API_KEY" },
	{ id: "openrouter", label: "OpenRouter", envKey: "OPENROUTER_API_KEY" },
];

const ACTIVE_PROVIDER_KEY = "trayapp.activeProvider";
const ROTATING_CLAUDE_KEY_PREFIXES = [
	"ANTHROPIC_API_KEY_",
	"CLAUDE_API_KEY_",
] as const;
const ROTATING_CLAUDE_LIST_KEYS = [
	"ANTHROPIC_API_KEYS",
	"CLAUDE_API_KEYS",
] as const;

function numericKeySuffix(key: string, prefix: string): number {
	const suffix = key.slice(prefix.length);
	return /^\d+$/.test(suffix) ? Number.parseInt(suffix, 10) : Number.MAX_SAFE_INTEGER;
}

export class VaultService {
	private managerPromise: Promise<SecretsManager> | null = null;

	manager(): Promise<SecretsManager> {
		if (!this.managerPromise) {
			// Bypass @napi-rs/keyring on macOS — its native binding fails to
			// load inside Electrobun's bundled Bun process. The `security` CLI
			// reads/writes the same keychain entry (service "eliza", account
			// "vault.masterKey") so the user's existing vault is read back
			// transparently. On other platforms, fall through to eliza's default.
			if (process.platform === "darwin") {
				const vault = createVault({ masterKey: securityCliMasterKey() });
				this.managerPromise = Promise.resolve(createManager({ vault }));
			} else {
				this.managerPromise = Promise.resolve(createManager());
			}
		}
		return this.managerPromise;
	}

	async vault() {
		return (await this.manager()).vault;
	}

	// --- LLM provider conveniences (high-level, app-specific) -----------------

	async listProviders(): Promise<ProviderInfo[]> {
		const manager = await this.manager();
		const active = await this.getActiveProvider();
		const out: ProviderInfo[] = [];
		for (const p of PROVIDERS) {
			out.push({
				id: p.id,
				label: p.label,
				hasKey: await manager.has(p.envKey),
				active: active === p.id,
			});
		}
		return out;
	}

	async setProviderKey(id: ProviderId, key: string): Promise<void> {
		const manager = await this.manager();
		const p = this.providerById(id);
		await manager.set(p.envKey, key, { sensitive: true });
		const v = manager.vault;
		if (!(await v.has(ACTIVE_PROVIDER_KEY))) {
			await v.set(ACTIVE_PROVIDER_KEY, id);
		}
	}

	async removeProviderKey(id: ProviderId): Promise<void> {
		const manager = await this.manager();
		const p = this.providerById(id);
		await manager.remove(p.envKey);
		delete process.env[p.envKey];
	}

	async getProviderKey(id: ProviderId): Promise<string | null> {
		const manager = await this.manager();
		const p = this.providerById(id);
		if (!(await manager.has(p.envKey))) return null;
		const value = await manager.get(p.envKey);
		return value.length > 0 ? value : null;
	}

	async getActiveProvider(): Promise<ProviderId | null> {
		const v = await this.vault();
		if (!(await v.has(ACTIVE_PROVIDER_KEY))) return null;
		const value = await v.get(ACTIVE_PROVIDER_KEY);
		if (PROVIDERS.some((p) => p.id === value)) return value as ProviderId;
		return null;
	}

	async setActiveProvider(id: ProviderId): Promise<void> {
		const v = await this.vault();
		this.providerById(id);
		await v.set(ACTIVE_PROVIDER_KEY, id);
	}

	async loadKeysIntoEnv(): Promise<ProviderId | null> {
		const manager = await this.manager();
		for (const p of PROVIDERS) {
			if (await manager.has(p.envKey)) {
				process.env[p.envKey] = await manager.get(p.envKey);
			}
		}
		for (const key of ROTATING_CLAUDE_LIST_KEYS) {
			if (await manager.has(key)) process.env[key] = await manager.get(key);
		}
		for (const prefix of ROTATING_CLAUDE_KEY_PREFIXES) {
			const keys = [...await manager.list(prefix)].sort((a, b) => numericKeySuffix(a, prefix) - numericKeySuffix(b, prefix) || a.localeCompare(b));
			for (const key of keys) {
				process.env[key] = await manager.get(key);
			}
		}
		return this.getActiveProvider();
	}

	private providerById(id: ProviderId) {
		const p = PROVIDERS.find((x) => x.id === id);
		if (!p) throw new Error(`Unknown provider: ${id}`);
		return p;
	}

}

// --- Free-standing vault helpers exposed to the API layer -------------------

export {
	listVaultInventory,
	categorizeKey,
	inferProviderId,
	readEntryMeta,
	setEntryMeta,
	removeEntryMeta,
	readRoutingConfig,
	writeRoutingConfig,
	BACKEND_INSTALL_SPECS,
	buildInstallCommand,
	currentPlatform,
	detectPackageManagers,
	resolveRunnableMethods,
	getSavedLogin,
	setSavedLogin,
	listSavedLogins,
	deleteSavedLogin,
	setAutofillAllowed,
	getAutofillAllowed,
	type BackendId,
	type BackendInstallSpec,
	type RoutingConfig,
	type SavedLogin,
	type SupportedPlatform,
	type VaultEntryMeta,
};
