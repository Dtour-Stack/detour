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
import { browserUseEnabled } from "../agent-tool-permissions";
import { captureScreen, type ScreenRegion } from "../../core/desktop-control";

const BROWSER_CONTROL_GLOBAL = Symbol.for("detour.browser.control");

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

type BrowserControl = {
	enqueue(command:
		| { kind: "open"; url: string; newTab?: boolean; source?: "agent" }
		| { kind: "inspect"; source?: "agent"; timeoutMs?: number }
		| { kind: "script"; script: string; source?: "agent"; timeoutMs?: number }
		| { kind: "screenshot"; source?: "agent"; timeoutMs?: number }
		| { kind: "fill-login"; source: "in-house" | "1password" | "bitwarden"; identifier: string; targetUrl?: string; newTab?: boolean; timeoutMs?: number }
	): { id: string; time: number };
	enqueueAndWait(command:
		| { kind: "inspect"; source?: "agent"; timeoutMs?: number }
		| { kind: "script"; script: string; source?: "agent"; timeoutMs?: number }
		| { kind: "screenshot"; source?: "agent"; timeoutMs?: number }
		| { kind: "fill-login"; source: "in-house" | "1password" | "bitwarden"; identifier: string; targetUrl?: string; newTab?: boolean; timeoutMs?: number },
		timeoutMs?: number,
	): Promise<{ ok: boolean; result?: unknown; error?: string; text?: string; time: number }>;
};

function getBrowserControl(): BrowserControl | null {
	const value = (globalThis as Record<symbol, unknown>)[BROWSER_CONTROL_GLOBAL];
	if (!value || typeof value !== "object") return null;
	const control = value as Partial<BrowserControl>;
	return typeof control.enqueue === "function" && typeof control.enqueueAndWait === "function"
		? control as BrowserControl
		: null;
}

/**
 * Eliza delivers extracted action params at `options.parameters` (canonical
 * contract). Some pipeline paths put them at the top level or nested under
 * `params`/`<ACTION>`/`arguments`. Walk all of those so the agent's chosen
 * action params actually land here. (Same fix shape as @detour/plugin-x-tweets.)
 */
function paramsBagV(opts: Record<string, unknown> | undefined): Record<string, unknown> {
	if (!opts) return {};
	const p = (opts as { parameters?: unknown }).parameters;
	if (p && typeof p === "object" && !Array.isArray(p)) return p as Record<string, unknown>;
	return {};
}

function pickStringOption(
	options: Record<string, unknown> | undefined,
	keys: readonly string[],
): string | undefined {
	if (!options) return undefined;
	const params = paramsBagV(options);
	for (const k of keys) {
		const v = params[k];
		if (typeof v === "string" && v.length > 0) return v;
	}
	for (const k of keys) {
		const v = options[k];
		if (typeof v === "string" && v.length > 0) return v;
	}
	const queue: Record<string, unknown>[] = [options];
	const seen = new Set<unknown>();
	while (queue.length > 0) {
		const cur = queue.shift()!;
		if (seen.has(cur)) continue;
		seen.add(cur);
		for (const k of keys) {
			const v = cur[k];
			if (typeof v === "string" && v.length > 0) return v;
		}
		for (const v of Object.values(cur)) {
			if (v && typeof v === "object" && !Array.isArray(v)) queue.push(v as Record<string, unknown>);
		}
	}
	return undefined;
}

function pickBoolOption(
	options: Record<string, unknown> | undefined,
	keys: readonly string[],
	fallback: boolean,
): boolean {
	if (!options) return fallback;
	const params = paramsBagV(options);
	const tryAt = (bag: Record<string, unknown>): boolean | undefined => {
		for (const k of keys) {
			const v = bag[k];
			if (typeof v === "boolean") return v;
			if (typeof v === "string") {
				if (v === "true") return true;
				if (v === "false") return false;
			}
		}
		return undefined;
	};
	return tryAt(params) ?? tryAt(options) ?? fallback;
}

function pickNumberOption(
	options: Record<string, unknown> | undefined,
	keys: readonly string[],
	fallback: number,
): number {
	if (!options) return fallback;
	const params = paramsBagV(options);
	for (const bag of [params, options]) {
		for (const k of keys) {
			const v = bag[k];
			if (typeof v === "number" && Number.isFinite(v)) return v;
			if (typeof v === "string") {
				const parsed = Number.parseInt(v, 10);
				if (Number.isFinite(parsed)) return parsed;
			}
		}
	}
	return fallback;
}

function previewValue(value: unknown, maxLength = 4_000): string {
	const text = typeof value === "string"
		? value
		: JSON.stringify(value, null, 2) ?? String(value);
	return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function inspectMessage(value: unknown): string {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return `Browser page inspected.\n${previewValue(value)}`;
	}
	const page = value as { title?: string; url?: string; text?: string };
	const lines = [
		"Browser page inspected.",
		page.title ? `Title: ${page.title}` : "",
		page.url ? `URL: ${page.url}` : "",
		page.text ? `Text:\n${previewValue(page.text, 3_000)}` : "",
	].filter((line) => line.length > 0);
	return lines.join("\n");
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
	const preview = summary.slice(0, 20).map((l) => {
		const label = l.title || l.domain || l.username || l.identifier;
		const username = l.username ? ` — ${l.username}` : "";
		return `- ${label}${username} [${l.source}] ${l.identifier}`;
	});
	const extra = summary.length > preview.length ? [`…and ${summary.length - preview.length} more.`] : [];
	await emit(
		callback,
		[
			`Found ${summary.length} saved logins${domain ? ` for ${domain}` : ""} (${result.failures.length} backend failures).`,
			...preview,
			...extra,
		].join("\n"),
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

// ── BROWSER_OPEN ───────────────────────────────────────────────────────────

const browserOpenHandler: Handler = async (runtime, _message, _state, options, callback) => {
	if (!browserUseEnabled()) return fail("Browser use is disabled in Settings → Agent Permissions.");
	const opts = options as Record<string, unknown> | undefined;
	const url = pickStringOption(opts, ["url", "target", "site", "query"]);
	if (!url || url.length > 2048) return fail("BROWSER_OPEN requires `url`.");
	const browser = getBrowserControl();
	if (!browser) return fail("Browser control is unavailable. Open the Detour app runtime first.");
	const newTab = pickBoolOption(opts, ["newTab", "new_tab"], true);
	const command = browser.enqueue({ kind: "open", url, newTab, source: "agent" });
	audit({ action: "browser_open", key: url, success: true, caller: caller(runtime), ts: Date.now() });
	await emit(callback, `Queued browser navigation for ${url}.`, "BROWSER_OPEN");
	return ok(`Browser command queued (${command.id}).`);
};

export const browserOpenAction: Action = {
	name: "BROWSER_OPEN",
	similes: ["OPEN_BROWSER", "NAVIGATE_BROWSER", "GO_TO_WEBSITE", "OPEN_URL"],
	description:
		"Open a URL or search query in the Detour browser window. The browser has multi-tab Electrobun webviews and shares a persistent browser partition for cookies and signed-in sessions.",
	validate: alwaysValid,
	handler: browserOpenHandler,
	examples: [],
	parameters: [
		{ name: "url", description: "URL, host, or search query to open.", required: true, schema: { type: "string" as const } },
		{ name: "newTab", description: "Open in a new tab. Defaults to true.", required: false, schema: { type: "boolean" as const } },
	],
} as Action;

// ── BROWSER_INSPECT ────────────────────────────────────────────────────────

const browserInspectHandler: Handler = async (runtime, _message, _state, options, callback) => {
	if (!browserUseEnabled()) return fail("Browser use is disabled in Settings → Agent Permissions.");
	const opts = options as Record<string, unknown> | undefined;
	const browser = getBrowserControl();
	if (!browser) return fail("Browser control is unavailable. Open the Detour app runtime first.");
	const timeoutMs = pickNumberOption(opts, ["timeoutMs", "timeout_ms"], 30_000);
	const result = await browser.enqueueAndWait({ kind: "inspect", source: "agent", timeoutMs }, timeoutMs + 2_000);
	audit({
		action: "browser_inspect",
		success: result.ok,
		...(result.error ? { error: result.error } : {}),
		caller: caller(runtime),
		ts: Date.now(),
	});
	if (!result.ok) return fail(result.error ?? "BROWSER_INSPECT failed.");
	const message = inspectMessage(result.result);
	await emit(callback, message, "BROWSER_INSPECT");
	return ok(message, { browser: result.result } as never);
};

export const browserInspectAction: Action = {
	name: "BROWSER_INSPECT",
	similes: ["INSPECT_BROWSER", "READ_BROWSER", "READ_PAGE", "GET_PAGE"],
	description:
		"Inspect the active Detour browser tab and return page URL, title, visible text, links, buttons, and fields. Use this before deciding what to click or type.",
	validate: alwaysValid,
	handler: browserInspectHandler,
	examples: [],
	parameters: [
		{ name: "timeoutMs", description: "Optional timeout in milliseconds.", required: false, schema: { type: "number" as const } },
	],
} as Action;

// ── BROWSER_SCRIPT ─────────────────────────────────────────────────────────

const browserScriptHandler: Handler = async (runtime, _message, _state, options, callback) => {
	if (!browserUseEnabled()) return fail("Browser use is disabled in Settings → Agent Permissions.");
	const opts = options as Record<string, unknown> | undefined;
	const script = pickStringOption(opts, ["script", "javascript", "js"]);
	if (!script) return fail("BROWSER_SCRIPT requires `script`.");
	if (script.length > 100_000) return fail("BROWSER_SCRIPT script is too large.");
	const browser = getBrowserControl();
	if (!browser) return fail("Browser control is unavailable. Open the Detour app runtime first.");
	const timeoutMs = pickNumberOption(opts, ["timeoutMs", "timeout_ms"], 30_000);
	const result = await browser.enqueueAndWait({ kind: "script", script, source: "agent", timeoutMs }, timeoutMs + 2_000);
	audit({
		action: "browser_script",
		success: result.ok,
		...(result.error ? { error: result.error } : {}),
		caller: caller(runtime),
		ts: Date.now(),
	});
	if (!result.ok) return fail(result.error ?? "BROWSER_SCRIPT failed.");
	const message = `Browser script executed.\nResult:\n${previewValue(result.result)}`;
	await emit(callback, message, "BROWSER_SCRIPT");
	return ok(message, { result: result.result } as never);
};

export const browserScriptAction: Action = {
	name: "BROWSER_SCRIPT",
	similes: ["RUN_BROWSER_SCRIPT", "EVALUATE_BROWSER", "CLICK_BROWSER", "TYPE_BROWSER"],
	description:
		"Run JavaScript in the active Detour browser tab and return the result. Use for page interaction, clicking elements, typing into forms, or extracting structured page data after BROWSER_INSPECT.",
	validate: alwaysValid,
	handler: browserScriptHandler,
	examples: [],
	parameters: [
		{ name: "script", description: "JavaScript to evaluate in the active browser tab.", required: true, schema: { type: "string" as const } },
		{ name: "timeoutMs", description: "Optional timeout in milliseconds.", required: false, schema: { type: "number" as const } },
	],
} as Action;

// ── BROWSER_SCREENSHOT ─────────────────────────────────────────────────────

function browserScreenshotRegion(result: unknown): ScreenRegion | null {
	const value = result && typeof result === "object" ? result as Record<string, unknown> : {};
	const rect = value.rect && typeof value.rect === "object" ? value.rect as Record<string, unknown> : {};
	const x = rect.x;
	const y = rect.y;
	const width = rect.width;
	const height = rect.height;
	if (
		typeof x !== "number"
		|| typeof y !== "number"
		|| typeof width !== "number"
		|| typeof height !== "number"
	) return null;
	return { x, y, width, height };
}

const browserScreenshotHandler: Handler = async (runtime, _message, _state, options, callback) => {
	if (!browserUseEnabled()) return fail("Browser use is disabled in Settings → Agent Permissions.");
	const opts = options as Record<string, unknown> | undefined;
	const browser = getBrowserControl();
	if (!browser) return fail("Browser control is unavailable. Open the Detour app runtime first.");
	const timeoutMs = pickNumberOption(opts, ["timeoutMs", "timeout_ms"], 30_000);
	const result = await browser.enqueueAndWait({ kind: "screenshot", source: "agent", timeoutMs }, timeoutMs + 2_000);
	if (!result.ok) return fail(result.error ?? "BROWSER_SCREENSHOT failed.");
	const region = browserScreenshotRegion(result.result);
	if (!region) return fail("BROWSER_SCREENSHOT could not locate the active browser view.");
	try {
		const screenshot = await captureScreen({ label: "browser", region, timeoutMs });
		audit({ action: "browser_screenshot", success: true, caller: caller(runtime), ts: Date.now() });
		const text = `Browser screenshot saved: ${screenshot.path}`;
		await emit(callback, text, "BROWSER_SCREENSHOT");
		return ok(text, { screenshot });
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		audit({ action: "browser_screenshot", success: false, error, caller: caller(runtime), ts: Date.now() });
		return fail(error);
	}
};

export const browserScreenshotAction: Action = {
	name: "BROWSER_SCREENSHOT",
	similes: ["CAPTURE_BROWSER", "SCREENSHOT_BROWSER", "SEE_BROWSER"],
	description:
		"Take a screenshot of the active Detour browser view and save it under ~/.detour/screenshots. Use this when the user wants to see what the agent browser is doing.",
	validate: alwaysValid,
	handler: browserScreenshotHandler,
	examples: [],
	parameters: [
		{ name: "timeoutMs", description: "Optional timeout in milliseconds.", required: false, schema: { type: "number" as const } },
	],
} as Action;

// ── BROWSER_FILL_LOGIN ─────────────────────────────────────────────────────

const browserFillLoginHandler: Handler = async (runtime, _message, _state, options, callback) => {
	if (!browserUseEnabled()) return fail("Browser use is disabled in Settings → Agent Permissions.");
	const opts = options as Record<string, unknown> | undefined;
	const source = pickStringOption(opts, ["source"]);
	const identifier = pickStringOption(opts, ["identifier", "id"]);
	const targetUrl = pickStringOption(opts, ["targetUrl", "url", "site"]);
	if (source !== "in-house" && source !== "1password" && source !== "bitwarden") {
		return fail("BROWSER_FILL_LOGIN requires `source` as in-house, 1password, or bitwarden.");
	}
	if (!identifier) return fail("BROWSER_FILL_LOGIN requires `identifier` from LOGIN_LIST.");
	const perm = check({ action: "read", target: `creds.${identifier}` });
	if (!perm.allowed) {
		audit({ action: "browser_fill_login", source, success: false, error: perm.reason, caller: caller(runtime), ts: Date.now() });
		return fail(perm.reason ?? "denied");
	}
	const browser = getBrowserControl();
	if (!browser) return fail("Browser control is unavailable. Open the Detour app runtime first.");
	const timeoutMs = pickNumberOption(opts, ["timeoutMs", "timeout_ms"], 30_000);
	const result = await browser.enqueueAndWait({
		kind: "fill-login",
		source,
		identifier,
		...(targetUrl ? { targetUrl } : {}),
		newTab: targetUrl ? pickBoolOption(opts, ["newTab", "new_tab"], true) : false,
		timeoutMs,
	}, timeoutMs + 15_000);
	audit({
		action: "browser_fill_login",
		source,
		success: result.ok,
		...(result.error ? { error: result.error } : {}),
		caller: caller(runtime),
		ts: Date.now(),
	});
	if (!result.ok) return fail(result.error ?? "BROWSER_FILL_LOGIN failed.");
	await emit(callback, `Queued browser autofill from ${source}.`, "BROWSER_FILL_LOGIN");
	return ok("Browser autofill complete.");
};

export const browserFillLoginAction: Action = {
	name: "BROWSER_FILL_LOGIN",
	similes: ["AUTOFILL_LOGIN", "FILL_PASSWORD", "USE_SAVED_LOGIN", "USE_1PASSWORD_LOGIN"],
	description:
		"Ask the Detour browser to autofill a saved login selected from LOGIN_LIST. This does not print the password in chat; the browser view reveals the credential locally and injects it into visible username/password/TOTP fields.",
	validate: alwaysValid,
	handler: browserFillLoginHandler,
	examples: [],
	parameters: [
		{ name: "source", description: "Login source from LOGIN_LIST: in-house | 1password | bitwarden.", required: true, schema: { type: "string" as const } },
		{ name: "identifier", description: "Login identifier from LOGIN_LIST.", required: true, schema: { type: "string" as const } },
		{ name: "targetUrl", description: "Optional URL/site to open before filling.", required: false, schema: { type: "string" as const } },
		{ name: "newTab", description: "Open targetUrl in a new tab. Defaults to true when targetUrl is set.", required: false, schema: { type: "boolean" as const } },
		{ name: "timeoutMs", description: "Optional timeout in milliseconds.", required: false, schema: { type: "number" as const } },
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
		browserOpenAction,
		browserInspectAction,
		browserScriptAction,
		browserScreenshotAction,
		browserFillLoginAction,
	],
};

export default vaultToolsPlugin;

// Re-exports for tests / advanced use + host config injection
export { check as checkVaultPermission, setPermissionConfig, getPermissionConfig } from "./permissions";
export type { AgentPermissionConfig, AgentVaultMode } from "./permissions";
export { audit as auditVaultAction } from "./audit";
