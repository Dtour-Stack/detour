/**
 * @detour/plugin-vault-tools
 *
 * Gives the agent in-conversation access to the vault and saved logins via
 * eliza Action surface. Every action is gated by the permission model in
 * `permissions.ts` (defaults to read-only) and audited to
 * ~/.eliza/audit/agent-vault-actions.jsonl.
 *
 * Required env (set by RuntimeService when this plugin is loaded):
 *   - VAULT_TOOLS_HANDLE = JSON-encoded string referencing the in-process
 *     vault — defaults to falling back on `createManager()` which reuses the
 *     same on-disk store as the API server. The handle exists so callers can
 *     inject a test/scoped manager.
 *
 * Action names:
 *   VAULT_READ      — fetch a single key's value
 *   VAULT_WRITE     — set a key (sensitive by default)
 *   VAULT_DELETE    — remove a key
 *   VAULT_LIST      — enumerate stored keys (no values)
 *   LOGIN_LIST      — list saved logins, optionally filtered by domain
 *   LOGIN_REVEAL    — reveal a single saved login (username/password/totp)
 *   LOGIN_SAVE      — store a new saved login (in-house only — vendor PMs
 *                     are read-only via this surface)
 */

import {
	createManager,
	createVault,
	type SecretsManager,
	setSavedLogin,
} from "@elizaos/vault";
import {
	type Action,
	type ActionResult,
	type Handler,
	type HandlerCallback,
	type IAgentRuntime,
	type Plugin,
} from "@elizaos/core";
import { audit } from "./audit";
import { check } from "./permissions";

// ── Manager singleton ─────────────────────────────────────────────────────
//
// We don't get the host's VaultService passed in (eliza's Plugin constructor
// doesn't take arbitrary deps). Instead we construct a manager the same way
// VaultService does, so we read/write the same on-disk file. If the host
// already swapped in a custom MasterKeyResolver via env (ELIZA_VAULT_PASSPHRASE
// etc.), eliza picks it up automatically; on macOS we also try the security
// CLI master key resolver since @napi-rs/keyring fails inside Electrobun.

let _manager: SecretsManager | null = null;

async function getManager(): Promise<SecretsManager> {
	if (_manager) return _manager;
	if (process.platform === "darwin") {
		// Match @detour/core's workaround: @napi-rs/keyring fails to load inside
		// Electrobun's bundled Bun process, so use the macOS `security` CLI
		// resolver against the same keychain entry the API server uses.
		const { securityCliMasterKey } = await import("./master-key-security-cli");
		_manager = createManager({ vault: createVault({ masterKey: securityCliMasterKey() }) });
	} else {
		_manager = createManager();
	}
	return _manager;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function caller(runtime: IAgentRuntime): string {
	return `agent:${runtime.character?.name ?? "unknown"}`;
}

function pickStringOption(
	options: Record<string, unknown> | undefined,
	keys: readonly string[],
): string | undefined {
	if (!options) return undefined;
	for (const k of keys) {
		const v = options[k];
		if (typeof v === "string" && v.length > 0) return v;
	}
	return undefined;
}

function pickBoolOption(
	options: Record<string, unknown> | undefined,
	keys: readonly string[],
	fallback: boolean,
): boolean {
	if (!options) return fallback;
	for (const k of keys) {
		const v = options[k];
		if (typeof v === "boolean") return v;
		if (typeof v === "string") {
			if (v === "true") return true;
			if (v === "false") return false;
		}
	}
	return fallback;
}

async function emit(callback: HandlerCallback | undefined, text: string, actionName: string): Promise<void> {
	if (!callback) return;
	try {
		await callback({ text, source: "vault-tools" } as never, actionName);
	} catch {
		// ignore
	}
}

const alwaysValid: Action["validate"] = async () => true;

function fail(reason: string): ActionResult {
	return { success: false, text: reason };
}

function ok(text: string, values?: Record<string, unknown>): ActionResult {
	return { success: true, text, ...(values ? { values: values as never } : {}) };
}

// ── VAULT_READ ─────────────────────────────────────────────────────────────

const vaultReadHandler: Handler = async (
	runtime,
	_message,
	_state,
	options,
	callback,
) => {
	const opts = options as Record<string, unknown> | undefined;
	const key = pickStringOption(opts, ["key", "name"]);
	if (!key) return fail("VAULT_READ requires `key`.");
	const perm = check({ action: "read", target: key });
	if (!perm.allowed) {
		audit({ action: "vault_read", key, success: false, error: perm.reason, caller: caller(runtime), ts: Date.now() });
		await emit(callback, `Vault read denied: ${perm.reason}`, "VAULT_READ");
		return fail(perm.reason ?? "denied");
	}
	const manager = await getManager();
	if (!(await manager.has(key))) {
		audit({ action: "vault_read", key, success: false, error: "not found", caller: caller(runtime), ts: Date.now() });
		return fail(`No vault entry for "${key}".`);
	}
	const value = await manager.get(key);
	audit({ action: "vault_read", key, success: true, caller: caller(runtime), ts: Date.now() });
	await emit(callback, `Read vault key "${key}".`, "VAULT_READ");
	return ok(`Vault["${key}"] = ${value}`, { vault_value: value });
};

export const vaultReadAction: Action = {
	name: "VAULT_READ",
	similes: ["READ_SECRET", "GET_VAULT_KEY", "FETCH_API_KEY"],
	description:
		"Read a single value from the user's encrypted vault by key name. Use for retrieving API keys, tokens, " +
		"or other secrets the user has stored. Defaults to read-only mode; system-internal keys (prefix `_manager.`, " +
		"`_meta.`, `_routing.`, `pm.`) are always denied.",
	validate: alwaysValid,
	handler: vaultReadHandler,
	examples: [],
	parameters: [
		{ name: "key", description: "Vault entry key to read (e.g. GITHUB_TOKEN).", required: true, schema: { type: "string" as const } },
	],
} as Action;

// ── VAULT_WRITE ────────────────────────────────────────────────────────────

const vaultWriteHandler: Handler = async (
	runtime,
	_message,
	_state,
	options,
	callback,
) => {
	const opts = options as Record<string, unknown> | undefined;
	const key = pickStringOption(opts, ["key", "name"]);
	const value = pickStringOption(opts, ["value", "secret"]);
	if (!key || value === undefined) return fail("VAULT_WRITE requires `key` and `value`.");
	const sensitive = pickBoolOption(opts, ["sensitive"], true);
	const perm = check({ action: "write", target: key });
	if (!perm.allowed) {
		audit({ action: "vault_write", key, success: false, error: perm.reason, caller: caller(runtime), ts: Date.now() });
		await emit(callback, `Vault write denied: ${perm.reason}`, "VAULT_WRITE");
		return fail(perm.reason ?? "denied");
	}
	const manager = await getManager();
	await manager.set(key, value, { sensitive, caller: caller(runtime) });
	audit({ action: "vault_write", key, success: true, caller: caller(runtime), ts: Date.now() });
	await emit(callback, `Saved vault key "${key}" (${sensitive ? "encrypted" : "plain"}).`, "VAULT_WRITE");
	return ok(`Saved "${key}".`);
};

export const vaultWriteAction: Action = {
	name: "VAULT_WRITE",
	similes: ["SET_SECRET", "SAVE_API_KEY", "STORE_VAULT_KEY"],
	description:
		"Store or overwrite a key in the user's encrypted vault. Set `sensitive: false` only for non-secret config. " +
		"Requires read-write mode (set in Configuration → Agent Permissions).",
	validate: alwaysValid,
	handler: vaultWriteHandler,
	examples: [],
	parameters: [
		{ name: "key", description: "Vault entry key (e.g. MY_API_TOKEN).", required: true, schema: { type: "string" as const } },
		{ name: "value", description: "Value to store. Encrypted at rest unless sensitive=false.", required: true, schema: { type: "string" as const } },
		{ name: "sensitive", description: "Encrypt the value (default true).", required: false, schema: { type: "boolean" as const } },
	],
} as Action;

// ── VAULT_DELETE ───────────────────────────────────────────────────────────

const vaultDeleteHandler: Handler = async (runtime, _message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const key = pickStringOption(opts, ["key", "name"]);
	if (!key) return fail("VAULT_DELETE requires `key`.");
	const perm = check({ action: "delete", target: key });
	if (!perm.allowed) {
		audit({ action: "vault_delete", key, success: false, error: perm.reason, caller: caller(runtime), ts: Date.now() });
		await emit(callback, `Vault delete denied: ${perm.reason}`, "VAULT_DELETE");
		return fail(perm.reason ?? "denied");
	}
	const manager = await getManager();
	if (!(await manager.has(key))) return fail(`No vault entry for "${key}".`);
	await manager.remove(key);
	audit({ action: "vault_delete", key, success: true, caller: caller(runtime), ts: Date.now() });
	await emit(callback, `Removed vault key "${key}".`, "VAULT_DELETE");
	return ok(`Removed "${key}".`);
};

export const vaultDeleteAction: Action = {
	name: "VAULT_DELETE",
	similes: ["REMOVE_SECRET", "FORGET_VAULT_KEY"],
	description: "Remove a key from the user's encrypted vault. Requires read-write mode.",
	validate: alwaysValid,
	handler: vaultDeleteHandler,
	examples: [],
	parameters: [
		{ name: "key", description: "Vault entry key to remove.", required: true, schema: { type: "string" as const } },
	],
} as Action;

// ── VAULT_LIST ─────────────────────────────────────────────────────────────

const vaultListHandler: Handler = async (runtime, _message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const prefix = pickStringOption(opts, ["prefix"]);
	const perm = check({ action: "list" });
	if (!perm.allowed) {
		audit({ action: "vault_list", success: false, error: perm.reason, caller: caller(runtime), ts: Date.now() });
		return fail(perm.reason ?? "denied");
	}
	const manager = await getManager();
	const all = (await manager.list(prefix)) as readonly string[];
	audit({ action: "vault_list", success: true, caller: caller(runtime), ts: Date.now() });
	await emit(callback, `Found ${all.length} vault keys${prefix ? ` matching "${prefix}"` : ""}.`, "VAULT_LIST");
	return ok(`Vault keys (${all.length}): ${all.slice(0, 50).join(", ")}${all.length > 50 ? ", …" : ""}`, {
		vault_keys: all,
	});
};

export const vaultListAction: Action = {
	name: "VAULT_LIST",
	similes: ["LIST_SECRETS", "WHAT_API_KEYS", "VAULT_INVENTORY"],
	description: "List the keys stored in the user's encrypted vault. Optional `prefix` filters by leading substring.",
	validate: alwaysValid,
	handler: vaultListHandler,
	examples: [],
	parameters: [
		{ name: "prefix", description: "Optional key-prefix filter.", required: false, schema: { type: "string" as const } },
	],
} as Action;

// ── LOGIN_LIST ─────────────────────────────────────────────────────────────

const loginListHandler: Handler = async (runtime, _message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const domain = pickStringOption(opts, ["domain", "host"]);
	const perm = check({ action: "list", target: domain ? `creds.${domain}` : undefined });
	if (!perm.allowed) {
		audit({ action: "login_list", domain, success: false, error: perm.reason, caller: caller(runtime), ts: Date.now() });
		return fail(perm.reason ?? "denied");
	}
	const manager = await getManager();
	const result = await manager.listAllSavedLogins(domain ? { domain } : {});
	audit({ action: "login_list", domain, success: true, caller: caller(runtime), ts: Date.now() });
	const summary = result.logins.map((l) => ({
		source: l.source,
		identifier: l.identifier,
		domain: l.domain,
		username: l.username,
		title: l.title,
	}));
	await emit(
		callback,
		`Found ${summary.length} saved logins${domain ? ` for ${domain}` : ""} (${result.failures.length} backend failures).`,
		"LOGIN_LIST",
	);
	return ok(
		`${summary.length} saved logins${domain ? ` for ${domain}` : ""}.`,
		{ logins: summary, failures: result.failures } as never,
	);
};

export const loginListAction: Action = {
	name: "LOGIN_LIST",
	similes: ["LIST_LOGINS", "FIND_PASSWORDS", "WHAT_LOGINS_FOR"],
	description:
		"List the user's saved login entries (in-house vault + signed-in password managers). Optional `domain` " +
		"narrows to one host. Returns metadata only — call LOGIN_REVEAL to fetch a specific credential. Useful for " +
		"browser-side autofill: query by `domain`, then reveal the chosen entry.",
	validate: alwaysValid,
	handler: loginListHandler,
	examples: [],
	parameters: [
		{ name: "domain", description: "Optional host filter (e.g. github.com).", required: false, schema: { type: "string" as const } },
	],
} as Action;

// ── LOGIN_REVEAL ───────────────────────────────────────────────────────────

const loginRevealHandler: Handler = async (runtime, _message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const source = pickStringOption(opts, ["source"]);
	const identifier = pickStringOption(opts, ["identifier", "id"]);
	if (!source || !identifier) return fail("LOGIN_REVEAL requires `source` and `identifier`.");
	if (source !== "in-house" && source !== "1password" && source !== "bitwarden") {
		return fail(`LOGIN_REVEAL: unsupported source "${source}".`);
	}
	const perm = check({ action: "read", target: `creds.${identifier}` });
	if (!perm.allowed) {
		audit({ action: "login_reveal", source, success: false, error: perm.reason, caller: caller(runtime), ts: Date.now() });
		return fail(perm.reason ?? "denied");
	}
	const manager = await getManager();
	try {
		const reveal = await manager.revealSavedLogin(source as "in-house" | "1password" | "bitwarden", identifier);
		audit({ action: "login_reveal", source, success: true, caller: caller(runtime), ts: Date.now() });
		await emit(callback, `Revealed credential from ${source} for ${reveal.domain ?? identifier}.`, "LOGIN_REVEAL");
		return ok(`Credential from ${source}.`, {
			username: reveal.username,
			password: reveal.password,
			...(reveal.totp ? { totp: reveal.totp } : {}),
			...(reveal.domain ? { domain: reveal.domain } : {}),
		} as never);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		audit({ action: "login_reveal", source, success: false, error: msg, caller: caller(runtime), ts: Date.now() });
		return fail(`LOGIN_REVEAL failed: ${msg}`);
	}
};

export const loginRevealAction: Action = {
	name: "LOGIN_REVEAL",
	similes: ["GET_PASSWORD", "FILL_LOGIN", "REVEAL_CREDENTIAL"],
	description:
		"Reveal a saved login's full credentials (username, password, optional TOTP). Required after LOGIN_LIST has " +
		"identified the desired entry. `source` is one of `in-house`, `1password`, `bitwarden`; `identifier` comes " +
		"from the LOGIN_LIST result. ALWAYS audited.",
	validate: alwaysValid,
	handler: loginRevealHandler,
	examples: [],
	parameters: [
		{ name: "source", description: "Backend: in-house | 1password | bitwarden.", required: true, schema: { type: "string" as const } },
		{ name: "identifier", description: "Entry id from LOGIN_LIST result.", required: true, schema: { type: "string" as const } },
	],
} as Action;

// ── LOGIN_SAVE (in-house only) ─────────────────────────────────────────────

const loginSaveHandler: Handler = async (runtime, _message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const domain = pickStringOption(opts, ["domain", "host"]);
	const username = pickStringOption(opts, ["username", "user", "email"]);
	const password = pickStringOption(opts, ["password", "secret"]);
	const otpSeed = pickStringOption(opts, ["otpSeed", "totp_seed"]);
	if (!domain || !username || !password) return fail("LOGIN_SAVE requires `domain`, `username`, `password`.");
	const perm = check({ action: "write", target: `creds.${domain}` });
	if (!perm.allowed) {
		audit({ action: "login_save", domain, username, success: false, error: perm.reason, caller: caller(runtime), ts: Date.now() });
		return fail(perm.reason ?? "denied");
	}
	const manager = await getManager();
	await setSavedLogin(manager.vault, {
		domain,
		username,
		password,
		...(otpSeed ? { otpSeed } : {}),
	});
	audit({ action: "login_save", domain, username, success: true, caller: caller(runtime), ts: Date.now() });
	await emit(callback, `Saved login for ${username}@${domain} (in-house).`, "LOGIN_SAVE");
	return ok(`Saved login ${username}@${domain}.`);
};

export const loginSaveAction: Action = {
	name: "LOGIN_SAVE",
	similes: ["SAVE_PASSWORD", "REMEMBER_LOGIN", "STORE_CREDENTIALS"],
	description:
		"Save a new login credential (in-house vault only — vendor password managers are read-only via this " +
		"surface). Requires `domain`, `username`, `password`. Optional `otpSeed` (base32 TOTP secret). Useful when " +
		"the agent has just signed the user up to a new site via the browser.",
	validate: alwaysValid,
	handler: loginSaveHandler,
	examples: [],
	parameters: [
		{ name: "domain", description: "Hostname of the site (e.g. github.com).", required: true, schema: { type: "string" as const } },
		{ name: "username", description: "Username or email.", required: true, schema: { type: "string" as const } },
		{ name: "password", description: "Password value.", required: true, schema: { type: "string" as const } },
		{ name: "otpSeed", description: "Optional base32 TOTP secret.", required: false, schema: { type: "string" as const } },
	],
} as Action;

// ── Plugin export ──────────────────────────────────────────────────────────

export const vaultToolsPlugin: Plugin = {
	name: "vault-tools",
	description:
		"Agent-side actions for reading and writing the user's encrypted vault and saved logins. Permission-gated " +
		"via ELIZA_VAULT_AGENT_MODE (off | read | read-write).",
	actions: [
		vaultReadAction,
		vaultWriteAction,
		vaultDeleteAction,
		vaultListAction,
		loginListAction,
		loginRevealAction,
		loginSaveAction,
	],
};

export default vaultToolsPlugin;

// Re-exports for tests / advanced use + host config injection
export { check as checkVaultPermission, setPermissionConfig, getPermissionConfig } from "./permissions";
export type { AgentPermissionConfig, AgentVaultMode } from "./permissions";
export { audit as auditVaultAction } from "./audit";
