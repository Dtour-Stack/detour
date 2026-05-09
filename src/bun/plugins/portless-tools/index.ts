/**
 * Portless tools plugin — gives the agent control of the standalone
 * `portless` CLI / daemon. The agent can start the proxy, stop it,
 * list routes, prune crashed sessions, install the system service,
 * trust the local CA, and sync /etc/hosts.
 *
 * All actions shell out to the user-installed `portless` binary
 * (`bun install -g portless` or `npm install -g portless`). If the
 * binary isn't found, the action fails with a clear "install portless"
 * message rather than swallowing the error.
 *
 * Privileged ops (proxy start, service install, hosts sync, trust)
 * trigger sudo prompts in the user's TTY when they need root. If the
 * agent is invoked from a channel without a TTY (Discord/X) and
 * portless requests sudo, the underlying spawn will fail and we
 * surface the stderr so the agent can ask the user to run the action
 * themselves at a terminal.
 */

import type { Action, ActionResult, Handler, IAgentRuntime, Plugin } from "@elizaos/core";

function ok(text: string, values?: Record<string, unknown>): ActionResult {
	return { success: true, text, ...(values ? { values: values as never } : {}) };
}

function fail(text: string): ActionResult {
	return { success: false, text };
}

async function emit(
	callback: ((r: { text: string; action: string }) => void | Promise<unknown>) | undefined,
	text: string,
	action: string,
): Promise<void> {
	if (!callback) return;
	try { await callback({ text, action }); } catch { /* best-effort */ }
}

function pickString(opts: Record<string, unknown> | undefined, keys: string[]): string | undefined {
	if (!opts) return undefined;
	for (const k of keys) {
		const v = opts[k];
		if (typeof v === "string" && v.trim().length > 0) return v.trim();
	}
	return undefined;
}

function pickNumber(opts: Record<string, unknown> | undefined, keys: string[]): number | undefined {
	if (!opts) return undefined;
	for (const k of keys) {
		const v = opts[k];
		if (typeof v === "number" && Number.isFinite(v)) return v;
		if (typeof v === "string") {
			const n = Number(v);
			if (Number.isFinite(n)) return n;
		}
	}
	return undefined;
}

function caller(runtime: IAgentRuntime): string {
	return runtime.character?.name ? `agent:${runtime.character.name}` : "agent";
}

async function portless(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
	try {
		const proc = Bun.spawn(["portless", ...args], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const exitCode = await proc.exited;
		return { ok: exitCode === 0, stdout, stderr, exitCode };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, stdout: "", stderr: `portless binary not runnable: ${msg}. Install with \`bun install -g portless\` or \`npm install -g portless\`.`, exitCode: -1 };
	}
}

function summarize(stdout: string, stderr: string, fallback: string): string {
	const out = `${stdout.trim()}${stderr.trim() ? `\n\nstderr: ${stderr.trim()}` : ""}`.trim();
	return out.length > 0 ? out : fallback;
}

// ── PORTLESS_LIST ──────────────────────────────────────────────────────

const listHandler: Handler = async (runtime, _m, _s, _options, callback) => {
	const r = await portless(["list"]);
	const text = r.ok
		? summarize(r.stdout, r.stderr, "No active routes.")
		: `portless list failed (exit ${r.exitCode}): ${r.stderr.trim()}`;
	await emit(callback, text, "PORTLESS_LIST");
	return r.ok
		? ok(text, { caller: caller(runtime), output: r.stdout })
		: fail(text);
};

export const portlessListAction: Action = {
	name: "PORTLESS_LIST",
	similes: ["LIST_PORTLESS_ROUTES", "PORTLESS_ROUTES"],
	description:
		"List active portless routes (`portless list`). Use to answer 'what URLs do I have running?' Each route shows hostname → port mapping.",
	validate: async () => true,
	handler: listHandler,
	examples: [],
	parameters: [],
} as Action;

// ── PORTLESS_PROXY_START ───────────────────────────────────────────────

const proxyStartHandler: Handler = async (runtime, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const noTls = pickString(opts, ["noTls", "no_tls", "http"]) === "true" || opts?.noTls === true || opts?.no_tls === true || opts?.http === true;
	const args = ["proxy", "start"];
	if (noTls) args.push("--no-tls");
	const r = await portless(args);
	const text = r.ok
		? summarize(r.stdout, r.stderr, `portless proxy started${noTls ? " (HTTP)" : " (HTTPS, port 443)"}.`)
		: `portless proxy start failed (exit ${r.exitCode}): ${r.stderr.trim() || r.stdout.trim() || "unknown error"}. The proxy needs root to bind ${noTls ? "80" : "443"}; if no sudo prompt appeared, run \`portless service install\` once at a terminal so the user can authorize, then retry.`;
	await emit(callback, text, "PORTLESS_PROXY_START");
	return r.ok ? ok(text, { caller: caller(runtime) }) : fail(text);
};

export const portlessProxyStartAction: Action = {
	name: "PORTLESS_PROXY_START",
	similes: ["START_PORTLESS_PROXY", "BOOT_PORTLESS"],
	description:
		"Start the standalone portless proxy daemon (`portless proxy start`). Default: HTTPS on port 443 (auto-elevates with sudo). Pass `noTls: true` for HTTP on port 80. Once running, every preview URL detour issues becomes port-less (`https://<slug>.localhost/`) instead of `:4848`. If sudo isn't available in the current shell, ask the user to run `portless service install` themselves.",
	validate: async () => true,
	handler: proxyStartHandler,
	examples: [],
	parameters: [
		{ name: "noTls", description: "Use HTTP on :80 instead of HTTPS on :443.", required: false, schema: { type: "boolean" as const } },
	],
} as Action;

// ── PORTLESS_PROXY_STOP ────────────────────────────────────────────────

const proxyStopHandler: Handler = async (runtime, _m, _s, _options, callback) => {
	const r = await portless(["proxy", "stop"]);
	const text = r.ok
		? summarize(r.stdout, r.stderr, "portless proxy stopped.")
		: `portless proxy stop failed (exit ${r.exitCode}): ${r.stderr.trim() || r.stdout.trim() || "unknown error"}`;
	await emit(callback, text, "PORTLESS_PROXY_STOP");
	return r.ok ? ok(text, { caller: caller(runtime) }) : fail(text);
};

export const portlessProxyStopAction: Action = {
	name: "PORTLESS_PROXY_STOP",
	similes: ["STOP_PORTLESS_PROXY", "KILL_PORTLESS"],
	description: "Stop the standalone portless proxy daemon. Routes stay registered in the store; only the proxy server stops. Restart with PORTLESS_PROXY_START.",
	validate: async () => true,
	handler: proxyStopHandler,
	examples: [],
	parameters: [],
} as Action;

// ── PORTLESS_PRUNE ─────────────────────────────────────────────────────

const pruneHandler: Handler = async (runtime, _m, _s, _options, callback) => {
	const r = await portless(["prune"]);
	const text = r.ok
		? summarize(r.stdout, r.stderr, "Pruned orphaned dev-server routes.")
		: `portless prune failed (exit ${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`;
	await emit(callback, text, "PORTLESS_PRUNE");
	return r.ok ? ok(text, { caller: caller(runtime) }) : fail(text);
};

export const portlessPruneAction: Action = {
	name: "PORTLESS_PRUNE",
	similes: ["CLEAN_PORTLESS", "PRUNE_DEAD_ROUTES"],
	description: "Kill orphaned dev-server processes whose routes are still in the portless store but whose owning process is gone. Use this to recover from 502 errors after a crashed `bun dev`.",
	validate: async () => true,
	handler: pruneHandler,
	examples: [],
	parameters: [],
} as Action;

// ── PORTLESS_ALIAS ─────────────────────────────────────────────────────

const aliasHandler: Handler = async (runtime, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const name = pickString(opts, ["name", "hostname", "alias"]);
	const port = pickNumber(opts, ["port"]);
	const remove = opts?.remove === true || pickString(opts, ["remove"]) === "true";
	if (!name) return fail("PORTLESS_ALIAS requires `name`.");
	if (remove) {
		const r = await portless(["alias", "--remove", name]);
		const text = r.ok ? `Removed alias ${name}.` : `portless alias --remove ${name} failed: ${r.stderr.trim()}`;
		await emit(callback, text, "PORTLESS_ALIAS");
		return r.ok ? ok(text, { caller: caller(runtime), name, removed: true }) : fail(text);
	}
	if (typeof port !== "number") return fail("PORTLESS_ALIAS requires `port` (or `remove: true`).");
	const r = await portless(["alias", name, String(port)]);
	const text = r.ok
		? `Registered ${name}.localhost → 127.0.0.1:${port}.`
		: `portless alias ${name} ${port} failed: ${r.stderr.trim()}`;
	await emit(callback, text, "PORTLESS_ALIAS");
	return r.ok ? ok(text, { caller: caller(runtime), name, port }) : fail(text);
};

export const portlessAliasAction: Action = {
	name: "PORTLESS_ALIAS",
	similes: ["REGISTER_ROUTE", "MAP_HOSTNAME"],
	description:
		"Register a static portless alias mapping a name → port (e.g. for a Docker container or external dev server detour didn't start). Required: `name`, `port`. Pass `remove: true` to remove. Routes survive across portless restarts.",
	validate: async () => true,
	handler: aliasHandler,
	examples: [],
	parameters: [
		{ name: "name", description: "Hostname (without .localhost suffix).", required: true, schema: { type: "string" as const } },
		{ name: "port", description: "Port number to route to (1-65535).", required: false, schema: { type: "number" as const } },
		{ name: "remove", description: "Remove the alias instead of adding (no port required).", required: false, schema: { type: "boolean" as const } },
	],
} as Action;

// ── PORTLESS_SERVICE_INSTALL ───────────────────────────────────────────

const serviceInstallHandler: Handler = async (runtime, _m, _s, _options, callback) => {
	const r = await portless(["service", "install"]);
	const text = r.ok
		? summarize(r.stdout, r.stderr, "Portless system service installed — proxy will auto-start on boot.")
		: `portless service install failed (exit ${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}. This needs sudo; if running from a non-interactive channel (Discord/X), ask the user to run \`portless service install\` themselves at a terminal.`;
	await emit(callback, text, "PORTLESS_SERVICE_INSTALL");
	return r.ok ? ok(text, { caller: caller(runtime) }) : fail(text);
};

export const portlessServiceInstallAction: Action = {
	name: "PORTLESS_SERVICE_INSTALL",
	similes: ["INSTALL_PORTLESS_SERVICE", "AUTOSTART_PORTLESS"],
	description:
		"Install the portless proxy as a system service so it auto-starts on boot (`portless service install`). One-time setup. Needs sudo. After this, the user never has to manually start portless again — preview URLs are always port-less.",
	validate: async () => true,
	handler: serviceInstallHandler,
	examples: [],
	parameters: [],
} as Action;

// ── PORTLESS_TRUST ─────────────────────────────────────────────────────

const trustHandler: Handler = async (runtime, _m, _s, _options, callback) => {
	const r = await portless(["trust"]);
	const text = r.ok
		? summarize(r.stdout, r.stderr, "Local CA added to system trust store. HTTPS portless URLs will now validate without browser warnings.")
		: `portless trust failed (exit ${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`;
	await emit(callback, text, "PORTLESS_TRUST");
	return r.ok ? ok(text, { caller: caller(runtime) }) : fail(text);
};

export const portlessTrustAction: Action = {
	name: "PORTLESS_TRUST",
	similes: ["TRUST_PORTLESS_CA", "INSTALL_PORTLESS_CERT"],
	description:
		"Add portless's local Certificate Authority to the system trust store (`portless trust`). One-time setup needed before HTTPS portless URLs work without browser warnings. Needs sudo.",
	validate: async () => true,
	handler: trustHandler,
	examples: [],
	parameters: [],
} as Action;

// ── PORTLESS_HOSTS_SYNC ────────────────────────────────────────────────

const hostsSyncHandler: Handler = async (runtime, _m, _s, _options, callback) => {
	const r = await portless(["hosts", "sync"]);
	const text = r.ok
		? summarize(r.stdout, r.stderr, "Synced portless routes to /etc/hosts (fixes Safari).")
		: `portless hosts sync failed (exit ${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`;
	await emit(callback, text, "PORTLESS_HOSTS_SYNC");
	return r.ok ? ok(text, { caller: caller(runtime) }) : fail(text);
};

export const portlessHostsSyncAction: Action = {
	name: "PORTLESS_HOSTS_SYNC",
	similes: ["SYNC_HOSTS_FILE", "ADD_PORTLESS_TO_HOSTS"],
	description:
		"Add portless routes to /etc/hosts (`portless hosts sync`). Required for Safari, which doesn't auto-resolve `*.localhost` like Chrome and Firefox do. Needs sudo.",
	validate: async () => true,
	handler: hostsSyncHandler,
	examples: [],
	parameters: [],
} as Action;

// ── PORTLESS_RUN ───────────────────────────────────────────────────────

const runHandler: Handler = async (runtime, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const cwd = pickString(opts, ["cwd", "dir", "directory"]);
	const name = pickString(opts, ["name"]);
	const cmd = pickString(opts, ["cmd", "command"]);
	const cmdArgs = Array.isArray(opts?.args) ? (opts!.args as unknown[]).filter((a): a is string => typeof a === "string") : [];
	if (!cwd) return fail("PORTLESS_RUN requires `cwd` (absolute project dir).");
	const args = ["run"];
	if (name) args.push("--name", name);
	if (cmd) args.push(cmd, ...cmdArgs);
	// `portless run` daemonizes — we wait briefly for it to register
	// the route, then return. The dev server keeps running in the
	// background under portless's supervision.
	try {
		const proc = Bun.spawn(["portless", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
		const settled = await Promise.race([
			proc.exited.then((code) => ({ done: true, code })),
			new Promise<{ done: false; code: null }>((r) => setTimeout(() => r({ done: false, code: null }), 4_000)),
		]);
		const stdout = await new Response(proc.stdout).text().catch(() => "");
		const stderr = await new Response(proc.stderr).text().catch(() => "");
		if (settled.done && settled.code !== 0) {
			const text = `portless run failed (exit ${settled.code}): ${stderr.trim() || stdout.trim()}`;
			await emit(callback, text, "PORTLESS_RUN");
			return fail(text);
		}
		const text = stdout.trim() || stderr.trim() || `portless run started in ${cwd}.`;
		await emit(callback, text, "PORTLESS_RUN");
		return ok(text, { caller: caller(runtime), cwd, name });
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
};

export const portlessRunAction: Action = {
	name: "PORTLESS_RUN",
	similes: ["PORTLESS_RUN_DEV", "RUN_THROUGH_PORTLESS"],
	description:
		"Run a project's dev server through portless from `cwd`. Bare invocation (`portless` from a project dir) reads package.json's \"dev\" script, picks a port, sets PORT, spawns the script, and registers the route. Required: `cwd` (absolute project dir). Optional: `name` (override inferred app name), `cmd` + `args` (run a non-default command instead of the dev script). The proxy auto-starts on first run if not already up. Use this for nextjs / vite / arbitrary dev servers — cleaner than spawning the dev server yourself + manually mapping the port.",
	validate: async () => true,
	handler: runHandler,
	examples: [],
	parameters: [
		{ name: "cwd", description: "Absolute project directory.", required: true, schema: { type: "string" as const } },
		{ name: "name", description: "Override the inferred app name (worktree prefix still applies).", required: false, schema: { type: "string" as const } },
		{ name: "cmd", description: "Run this command instead of the configured dev script.", required: false, schema: { type: "string" as const } },
		{ name: "args", description: "Args for the command (when cmd is set).", required: false, schema: { type: "array" as const } },
	],
} as Action;

// ── PORTLESS_GET ───────────────────────────────────────────────────────

const getHandler: Handler = async (runtime, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const name = pickString(opts, ["name"]);
	if (!name) return fail("PORTLESS_GET requires `name`.");
	const r = await portless(["get", name]);
	const text = r.ok ? r.stdout.trim() : `portless get ${name} failed: ${r.stderr.trim()}`;
	await emit(callback, text, "PORTLESS_GET");
	return r.ok ? ok(text, { caller: caller(runtime), name, url: r.stdout.trim() }) : fail(text);
};

export const portlessGetAction: Action = {
	name: "PORTLESS_GET",
	similes: ["GET_PORTLESS_URL"],
	description: "Resolve the URL for a portless-registered service (`portless get <name>`). Useful for cross-service references — e.g. backend env vars pointing at a frontend.",
	validate: async () => true,
	handler: getHandler,
	examples: [],
	parameters: [
		{ name: "name", description: "Service name registered with portless.", required: true, schema: { type: "string" as const } },
	],
} as Action;

// ── PORTLESS_SERVICE_STATUS ────────────────────────────────────────────

const serviceStatusHandler: Handler = async (runtime, _m, _s, _options, callback) => {
	const r = await portless(["service", "status"]);
	const text = summarize(r.stdout, r.stderr, r.ok ? "Service status reported." : `portless service status failed (exit ${r.exitCode})`);
	await emit(callback, text, "PORTLESS_SERVICE_STATUS");
	return r.ok ? ok(text, { caller: caller(runtime) }) : fail(text);
};

export const portlessServiceStatusAction: Action = {
	name: "PORTLESS_SERVICE_STATUS",
	similes: ["CHECK_PORTLESS_SERVICE"],
	description: "Check whether the portless OS startup service is installed and running (`portless service status`).",
	validate: async () => true,
	handler: serviceStatusHandler,
	examples: [],
	parameters: [],
} as Action;

// ── PORTLESS_SERVICE_UNINSTALL ─────────────────────────────────────────

const serviceUninstallHandler: Handler = async (runtime, _m, _s, _options, callback) => {
	const r = await portless(["service", "uninstall"]);
	const text = r.ok ? "Portless OS startup service uninstalled." : `portless service uninstall failed (exit ${r.exitCode}): ${r.stderr.trim()}`;
	await emit(callback, text, "PORTLESS_SERVICE_UNINSTALL");
	return r.ok ? ok(text, { caller: caller(runtime) }) : fail(text);
};

export const portlessServiceUninstallAction: Action = {
	name: "PORTLESS_SERVICE_UNINSTALL",
	similes: ["UNINSTALL_PORTLESS_SERVICE"],
	description: "Remove the portless OS startup service (`portless service uninstall`). Needs admin privs.",
	validate: async () => true,
	handler: serviceUninstallHandler,
	examples: [],
	parameters: [],
} as Action;

// ── PORTLESS_HOSTS_CLEAN ───────────────────────────────────────────────

const hostsCleanHandler: Handler = async (runtime, _m, _s, _options, callback) => {
	const r = await portless(["hosts", "clean"]);
	const text = r.ok ? "Portless entries removed from /etc/hosts." : `portless hosts clean failed (exit ${r.exitCode}): ${r.stderr.trim()}`;
	await emit(callback, text, "PORTLESS_HOSTS_CLEAN");
	return r.ok ? ok(text, { caller: caller(runtime) }) : fail(text);
};

export const portlessHostsCleanAction: Action = {
	name: "PORTLESS_HOSTS_CLEAN",
	similes: ["CLEAN_PORTLESS_HOSTS"],
	description: "Remove portless entries from /etc/hosts (`portless hosts clean`). Inverse of PORTLESS_HOSTS_SYNC.",
	validate: async () => true,
	handler: hostsCleanHandler,
	examples: [],
	parameters: [],
} as Action;

// ── PORTLESS_CLEAN ─────────────────────────────────────────────────────

const cleanHandler: Handler = async (runtime, _m, _s, _options, callback) => {
	const r = await portless(["clean"]);
	const text = summarize(r.stdout, r.stderr, r.ok ? "Portless state cleared." : `portless clean failed (exit ${r.exitCode})`);
	await emit(callback, text, "PORTLESS_CLEAN");
	return r.ok ? ok(text, { caller: caller(runtime) }) : fail(text);
};

export const portlessCleanAction: Action = {
	name: "PORTLESS_CLEAN",
	similes: ["RESET_PORTLESS"],
	description:
		"Full portless reset (`portless clean`): stops proxy, removes CA from system trust store, deletes ~/.portless state, removes /etc/hosts entries. Use when troubleshooting persistent issues. Needs sudo. Custom --cert/--key paths are NOT removed by this.",
	validate: async () => true,
	handler: cleanHandler,
	examples: [],
	parameters: [],
} as Action;

// ── Plugin export ──────────────────────────────────────────────────────

export const portlessToolsPlugin: Plugin = {
	name: "portless-tools",
	description:
		"Standalone portless CLI control: PORTLESS_LIST (active routes), PORTLESS_PROXY_START / STOP (boot the daemon on 443/80), PORTLESS_PRUNE (clean dead routes), PORTLESS_ALIAS (register/remove static routes), PORTLESS_SERVICE_INSTALL (auto-start on boot), PORTLESS_TRUST (system CA trust), PORTLESS_HOSTS_SYNC (Safari /etc/hosts entries). All shell out to the user-installed `portless` binary; privileged ops trigger sudo. Use these to give users port-less preview URLs (`https://<slug>.localhost/`) instead of detour's :4848 fallback.",
	actions: [
		portlessListAction,
		portlessProxyStartAction,
		portlessProxyStopAction,
		portlessPruneAction,
		portlessAliasAction,
		portlessRunAction,
		portlessGetAction,
		portlessServiceInstallAction,
		portlessServiceStatusAction,
		portlessServiceUninstallAction,
		portlessTrustAction,
		portlessHostsSyncAction,
		portlessHostsCleanAction,
		portlessCleanAction,
	],
};
