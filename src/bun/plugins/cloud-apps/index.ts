/**
 * Cloud-apps plugin — agent actions for ElizaOS Cloud app management.
 *
 * The agent can:
 *   - CLOUD_LIST_APPS: introspect what apps the user already has
 *   - CLOUD_CREATE_APP: provision a new app (issues an API key + optional
 *     GitHub repo via the cloud's app-factory service)
 *   - CLOUD_LIST_CONTAINERS: introspect hosted agent runtimes
 *
 * Container *creation* requires the cloud-side container control plane
 * (Hetzner / Docker SSH provisioning) and isn't safe to expose as a free-
 * form agent action — link out to the dashboard if the agent needs one.
 *
 * All actions read the user's stored ELIZAOS_CLOUD_API_KEY from the
 * vault. If it's not present, the action returns a "not signed in"
 * error rather than silently failing.
 */

import type { Action, ActionResult, Handler, IAgentRuntime, Plugin } from "@elizaos/core";

const ELIZACLOUD_BASE = "https://www.elizacloud.ai/api/v1";
const APPS_URL = `${ELIZACLOUD_BASE}/apps`;
const CONTAINERS_URL = `${ELIZACLOUD_BASE}/containers`;

type Caller = (runtime: IAgentRuntime) => string;
const caller: Caller = (runtime) => (runtime.character?.name ? `agent:${runtime.character.name}` : "agent");

function getApiKey(runtime: IAgentRuntime): string | null {
	const key = runtime.getSetting?.("ELIZAOS_CLOUD_API_KEY") ?? process.env.ELIZAOS_CLOUD_API_KEY;
	return typeof key === "string" && key.length > 0 ? key : null;
}

function pickString(opts: Record<string, unknown> | undefined, keys: string[]): string | undefined {
	if (!opts) return undefined;
	for (const k of keys) {
		const v = opts[k];
		if (typeof v === "string" && v.trim().length > 0) return v.trim();
	}
	return undefined;
}

function pickBool(opts: Record<string, unknown> | undefined, key: string, dflt: boolean): boolean {
	if (!opts) return dflt;
	const v = opts[key];
	return typeof v === "boolean" ? v : dflt;
}

function ok(text: string, values?: Record<string, unknown>): ActionResult {
	// Cast through `as never` matches the convention from vault-tools —
	// ActionResult.values has a tighter `ProviderDataRecord` index
	// constraint that newer eliza/core narrows further; our handlers
	// emit plain JSON-like records and the runtime accepts them.
	return { success: true, text, ...(values ? { values: values as never } : {}) };
}

function fail(text: string): ActionResult {
	return { success: false, text };
}

async function emit(
	callback: ((result: { text: string; action: string }) => void | Promise<unknown>) | undefined,
	text: string,
	action: string,
): Promise<void> {
	if (!callback) return;
	try { await callback({ text, action }); } catch { /* best-effort */ }
}

// ── CLOUD_LIST_APPS ────────────────────────────────────────────────────

const listAppsHandler: Handler = async (runtime, _message, _state, _options, callback) => {
	const key = getApiKey(runtime);
	if (!key) return fail("Not signed in to ElizaOS Cloud. Have the user run Cloud → ElizaOS Cloud → Connect.");
	try {
		const res = await fetch(APPS_URL, { headers: { Authorization: `Bearer ${key}` } });
		if (!res.ok) {
			const body = await res.text().catch(() => res.statusText);
			return fail(`Cloud apps list failed: HTTP ${res.status}: ${body.slice(0, 200)}`);
		}
		const json = (await res.json()) as { apps?: Array<{ id: string; name: string; description?: string | null; app_url?: string | null }> };
		const apps = Array.isArray(json.apps) ? json.apps : [];
		const summary = apps.length === 0
			? "No cloud apps registered yet."
			: apps.map((a) => `• ${a.name} (id=${a.id})${a.description ? ` — ${a.description}` : ""}`).join("\n");
		await emit(callback, summary, "CLOUD_LIST_APPS");
		return ok(`Found ${apps.length} app(s).`, { apps, caller: caller(runtime) });
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
};

export const cloudListAppsAction: Action = {
	name: "CLOUD_LIST_APPS",
	similes: ["LIST_CLOUD_APPS", "MY_CLOUD_APPS", "CLOUD_APPS"],
	description:
		"List the user's apps registered in ElizaOS Cloud. Use when the user asks 'what apps do I have?', 'show my hosted apps', etc. Returns id, name, description, and app_url for each.",
	validate: async () => true,
	handler: listAppsHandler,
	examples: [],
	parameters: [],
} as Action;

// ── CLOUD_CREATE_APP ───────────────────────────────────────────────────

const createAppHandler: Handler = async (runtime, _message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const name = pickString(opts, ["name", "appName"]);
	const appUrl = pickString(opts, ["app_url", "appUrl", "url"]);
	if (!name) return fail("CLOUD_CREATE_APP requires a `name` parameter.");
	if (!appUrl) return fail("CLOUD_CREATE_APP requires an `app_url` parameter (the public URL the app will be served at).");

	const key = getApiKey(runtime);
	if (!key) return fail("Not signed in to ElizaOS Cloud. Have the user run Cloud → ElizaOS Cloud → Connect.");

	const description = pickString(opts, ["description"]);
	const websiteUrl = pickString(opts, ["website_url", "websiteUrl"]);
	const contactEmail = pickString(opts, ["contact_email", "contactEmail"]);
	const logoUrl = pickString(opts, ["logo_url", "logoUrl"]);
	const skipGitHubRepo = pickBool(opts, "skipGitHubRepo", true); // default true: don't autocreate a repo
	const allowedOriginsRaw = opts?.["allowed_origins"] ?? opts?.["allowedOrigins"];
	const allowedOrigins = Array.isArray(allowedOriginsRaw)
		? allowedOriginsRaw.filter((s): s is string => typeof s === "string")
		: undefined;

	try {
		const res = await fetch(APPS_URL, {
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				name,
				app_url: appUrl,
				...(description ? { description } : {}),
				...(websiteUrl ? { website_url: websiteUrl } : {}),
				...(contactEmail ? { contact_email: contactEmail } : {}),
				...(logoUrl ? { logo_url: logoUrl } : {}),
				...(allowedOrigins ? { allowed_origins: allowedOrigins } : {}),
				skipGitHubRepo,
			}),
		});
		if (!res.ok) {
			const body = await res.text().catch(() => res.statusText);
			return fail(`Cloud app create failed: HTTP ${res.status}: ${body.slice(0, 240)}`);
		}
		const data = (await res.json()) as { success?: boolean; app?: { id?: string; name?: string }; api_key?: string };
		const newAppId = data.app?.id ?? "";
		const summary = `Created app "${name}" (id=${newAppId}). API key issued separately by the cloud — see /dashboard/apps/${newAppId}.`;
		await emit(callback, summary, "CLOUD_CREATE_APP");
		return ok(summary, {
			caller: caller(runtime),
			id: newAppId,
			name: data.app?.name ?? name,
			...(data.api_key ? { api_key_preview: `${data.api_key.slice(0, 8)}…` } : {}),
		});
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
};

export const cloudCreateAppAction: Action = {
	name: "CLOUD_CREATE_APP",
	similes: ["NEW_CLOUD_APP", "REGISTER_APP", "PROVISION_APP"],
	description:
		"Create a new app registration on ElizaOS Cloud. Requires `name` (string, 1-100 chars) and `app_url` (the public URL the app will run at). Optional: `description`, `website_url`, `contact_email`, `logo_url`, `allowed_origins` (string array), `skipGitHubRepo` (default true — set false to also auto-provision a GitHub repo). The cloud responds with an app id + a freshly minted API key. Use when the user says 'create an app for X', 'register a new app', etc.",
	validate: async () => true,
	handler: createAppHandler,
	examples: [],
	parameters: [
		{ name: "name", description: "App display name (1-100 chars).", required: true, schema: { type: "string" as const } },
		{ name: "app_url", description: "Public URL the app runs at.", required: true, schema: { type: "string" as const } },
		{ name: "description", description: "Optional description.", required: false, schema: { type: "string" as const } },
		{ name: "website_url", description: "Optional website URL.", required: false, schema: { type: "string" as const } },
		{ name: "contact_email", description: "Optional support email.", required: false, schema: { type: "string" as const } },
		{ name: "logo_url", description: "Optional logo URL.", required: false, schema: { type: "string" as const } },
		{ name: "skipGitHubRepo", description: "Skip auto-provisioning a GitHub repo (default true).", required: false, schema: { type: "boolean" as const } },
	],
} as Action;

// ── CLOUD_LIST_CONTAINERS ──────────────────────────────────────────────

const listContainersHandler: Handler = async (runtime, _message, _state, _options, callback) => {
	const key = getApiKey(runtime);
	if (!key) return fail("Not signed in to ElizaOS Cloud. Have the user run Cloud → ElizaOS Cloud → Connect.");
	try {
		const res = await fetch(CONTAINERS_URL, { headers: { Authorization: `Bearer ${key}` } });
		if (!res.ok) {
			const body = await res.text().catch(() => res.statusText);
			return fail(`Cloud containers list failed: HTTP ${res.status}: ${body.slice(0, 200)}`);
		}
		const json = (await res.json()) as { data?: Array<{ id: string; name?: string; status?: string; image?: string }> };
		const containers = Array.isArray(json.data) ? json.data : [];
		const summary = containers.length === 0
			? "No hosted agent containers."
			: containers.map((c) => `• ${c.name ?? c.id} [${c.status ?? "unknown"}]${c.image ? ` (${c.image})` : ""}`).join("\n");
		await emit(callback, summary, "CLOUD_LIST_CONTAINERS");
		return ok(`Found ${containers.length} container(s).`, { containers, caller: caller(runtime) });
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
};

export const cloudListContainersAction: Action = {
	name: "CLOUD_LIST_CONTAINERS",
	similes: ["LIST_HOSTED_AGENTS", "MY_CONTAINERS"],
	description:
		"List the user's hosted agent runtimes (Hetzner-Docker containers) on ElizaOS Cloud. Returns id, name, status, image. Provisioning new containers requires the cloud's container control plane and is done via the dashboard, not from this action.",
	validate: async () => true,
	handler: listContainersHandler,
	examples: [],
	parameters: [],
} as Action;

// ── Plugin export ──────────────────────────────────────────────────────

export const cloudAppsPlugin: Plugin = {
	name: "cloud-apps",
	description:
		"ElizaOS Cloud app + container management actions: CLOUD_LIST_APPS (introspect user apps), CLOUD_CREATE_APP (provision a new app + API key), CLOUD_LIST_CONTAINERS (introspect hosted agent runtimes). All actions require the user to be signed in via Cloud → ElizaOS Cloud → Connect (stores ELIZAOS_CLOUD_API_KEY in the vault).",
	actions: [
		cloudListAppsAction,
		cloudCreateAppAction,
		cloudListContainersAction,
	],
};
