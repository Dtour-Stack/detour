/**
 * detour:// URL scheme handler — lets external callers (Shortcuts.app,
 * AppleScript, Raycast, Alfred, command-line `open detour://...`) drive
 * Detour without IPC.
 *
 * macOS only. Electrobun registers the scheme via `app.urlSchemes` in
 * electrobun.config.ts; macOS opens the app (if not running) and fires
 * an "open-url" event with the URL.
 *
 * Routes:
 *
 *   detour://chat?text=<prompt>&submit=1
 *     Open the chat hub. If `text` is set, inject it into the
 *     composer; if `submit=1` also send it.
 *
 *   detour://settings?tab=<section>:<tab>
 *     Open Settings (chat drawer) on a specific tab. Same deep-link
 *     format the command palette uses.
 *
 *   detour://window?target=<name>
 *     Open / focus a named window. <name> is any WindowOpenTarget.
 *
 *   detour://action?name=<ACTION_NAME>&<key>=<value>...
 *     Queue an agent action via the inbox pipeline. Useful for
 *     Shortcuts that want to fire-and-forget a pre-baked action
 *     (PENSIEVE_SEARCH, REMINDERS_ADD, etc.).
 *
 *   detour://pensieve/search?q=<query>
 *     Open Pensieve scoped to a search result.
 *
 *   detour://ping
 *     Health check — replies with "ok" in logs. Used by Shortcuts
 *     authors to verify the URL scheme is wired up.
 *
 * Unknown routes log a warning but don't crash — external callers
 * should be tolerant of future route additions.
 */

import Electrobun from "electrobun/bun";
import { logger } from "@elizaos/core";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { broadcaster } from "../../core/rpc/registry";
import type { Feature } from "../../kernel/registry";
import type { WindowOpenTarget } from "../../../shared/index";

/**
 * Locate the embedded DetourBridge.app inside our own bundle. macOS
 * needs to register it with LaunchServices once so AppleScript can
 * dispatch to it by bundle ID. We do this fire-and-forget on first
 * run — repeat calls are idempotent.
 *
 * Returns null in dev (when running source directly) — `lsregister`
 * would point at a bundle we haven't built yet.
 */
function findBundledBridge(): string | null {
	if (!process.execPath) return null;
	const candidate = join(
		dirname(process.execPath),
		"..",
		"Resources",
		"app",
		"DetourBridge.app",
	);
	// Electrobun packages our copy map under Resources/app; postBuild
	// embeds the bridge alongside the bun output. We also accept the
	// legacy Resources/DetourBridge.app location for safety.
	const legacy = join(
		dirname(process.execPath),
		"..",
		"Resources",
		"DetourBridge.app",
	);
	if (existsSync(candidate)) return candidate;
	if (existsSync(legacy)) return legacy;
	return null;
}

/**
 * Locate an embedded SwiftUI companion bundle inside our own .app.
 * Used to route `detour://window?target=…` and `detour://settings`
 * into native windows when the corresponding companion is bundled.
 * Returns null in dev-source mode (no bundle yet) so the React
 * surface stays as fallback.
 *
 * Companions today:
 *   - DetourSettings.app  (Settings — native SwiftUI shell)
 *   - DetourActivity.app  (trajectories / logs / runtime)
 *   - DetourPensieve.app  (memory / search / relationships)
 *
 * Add to BUNDLED_COMPANIONS when shipping new companions.
 */
const BUNDLED_COMPANIONS: Record<string, string> = {
	settings: "DetourSettings.app",
	activity: "DetourActivity.app",
	pensieve: "DetourPensieve.app",
	chat: "DetourChat.app",
	browser: "DetourBrowser.app",
	gallery: "DetourGallery.app",
	workspace: "DetourWorkspace.app",
};

function findBundledCompanion(target: string): string | null {
	const name = BUNDLED_COMPANIONS[target];
	if (!name || !process.execPath) return null;
	const candidates = [
		join(dirname(process.execPath), "..", "Resources", "app", name),
		join(dirname(process.execPath), "..", "Resources", name),
	];
	for (const c of candidates) if (existsSync(c)) return c;
	return null;
}

function findBundledSettings(): string | null {
	return findBundledCompanion("settings");
}

function spawnCompanion(appPath: string, binaryName: string): boolean {
	const binary = join(appPath, "Contents", "MacOS", binaryName);
	if (!existsSync(binary)) return false;
	try {
		spawn(binary, [], { stdio: "ignore", detached: true }).unref();
		return true;
	} catch (err) {
		logger.warn({ src: "url-scheme", binaryName, err }, "[UrlScheme] companion spawn failed");
		return false;
	}
}

function registerBridgeWithLaunchServices(): void {
	const bridgePath = findBundledBridge();
	if (!bridgePath) {
		logger.info({ src: "url-scheme" }, "[UrlScheme] DetourBridge.app not bundled; skipping LS registration");
		return;
	}
	// `lsregister` lives at a deep system path; -f forces re-registration
	// (idempotent if already registered to the same bundle path).
	const lsregister =
		"/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
	if (!existsSync(lsregister)) {
		logger.warn({ src: "url-scheme" }, "[UrlScheme] lsregister not found; skipping bridge registration");
		return;
	}
	const child = spawn(lsregister, ["-f", bridgePath], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.once("close", (code) => {
		if (code === 0) {
			logger.info({ src: "url-scheme", bridgePath }, "[UrlScheme] registered DetourBridge.app");
		} else {
			logger.warn({ src: "url-scheme", code }, "[UrlScheme] lsregister failed");
		}
	});
}

const VALID_TARGETS = new Set<WindowOpenTarget>([
	"chat",
	"command-palette",
	"settings",
	"pensieve",
	"activity",
	"browser",
	"agents",
	"pet",
	"gallery",
	"portless",
	"workspace",
]);

function parseUrl(raw: string): URL | null {
	try {
		// Node's URL parses opaque schemes fine; we just need .pathname
		// + .searchParams + .host. The trailing slash is forgiving.
		return new URL(raw);
	} catch {
		return null;
	}
}

function asString(value: string | null | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function asBool(value: string | null | undefined): boolean {
	if (!value) return false;
	const lower = value.toLowerCase();
	return ["1", "true", "yes", "on"].includes(lower);
}

/**
 * Global dispatcher registered at feature init. The API server's
 * `POST /api/url-scheme/dispatch` route reads this so the Swift tray
 * + AppleScript can dispatch detour:// URLs straight into the running
 * bun without bouncing through LaunchServices (which may resolve the
 * scheme to a stale Electrobun bundle while we're mid-cutover).
 *
 * Self-dispatched URLs (Swiftun → Swiftun's bun) avoid the dual-
 * registration race entirely. External callers (Shortcuts.app, raw
 * `open detour://…` from terminal) still come in via the OS-level
 * URL handler.
 */
type UrlSchemeDispatcher = (rawUrl: string) => boolean;
const DISPATCHER_KEY = Symbol.for("detour.url-scheme.dispatch");
type DispatcherHost = { [DISPATCHER_KEY]?: UrlSchemeDispatcher };

export function getUrlSchemeDispatcher(): UrlSchemeDispatcher | null {
	const host = globalThis as unknown as DispatcherHost;
	return host[DISPATCHER_KEY] ?? null;
}

export const urlSchemeFeature: Feature = {
	id: "url-scheme",
	init(deps) {
		try {
			registerBridgeWithLaunchServices();
		} catch (err) {
			console.warn("[url-scheme] bridge registration failed:", err);
		}
		const dispatch: UrlSchemeDispatcher = (raw: string): boolean => {
			if (!raw.startsWith("detour:")) return false;
				const url = parseUrl(raw);
				if (!url) {
					logger.warn({ src: "url-scheme", raw }, "[UrlScheme] could not parse URL");
					return false;
				}
			const route = (url.host || "").toLowerCase();
			const sub = url.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
			const params = url.searchParams;
				try {
					handleRoute(route, sub, params, deps);
					return true;
				} catch (err) {
					logger.warn({ src: "url-scheme", route, sub, err }, "[UrlScheme] handler failed");
					return false;
				}
			};
		(globalThis as unknown as DispatcherHost)[DISPATCHER_KEY] = dispatch;
		Electrobun.events.on("open-url", (e: { data: { url: string } }) => {
				const raw = e?.data?.url ?? "";
				if (!raw.startsWith("detour:")) return;
				logger.info({ src: "url-scheme", raw }, "[UrlScheme] external open-url");
				dispatch(raw);
			});
	},
};

type UrlRouteDeps = Parameters<Feature["init"]>[0];
type UrlRouteHandler = (sub: string, params: URLSearchParams, deps: UrlRouteDeps, route: string) => void;

const URL_ROUTE_HANDLERS: Record<string, UrlRouteHandler> = {
	ping: handlePingRoute,
	chat: handleChatRoute,
	settings: handleSettingsRoute,
	window: handleWindowRoute,
	localchat: handleLocalAiRoute,
	companion: handleLocalAiRoute,
	pensieve: handlePensieveRoute,
	action: handleActionRoute,
};

function handleRoute(route: string, sub: string, params: URLSearchParams, deps: UrlRouteDeps): void {
	const handler = URL_ROUTE_HANDLERS[route];
	if (!handler) {
		logger.warn({ src: "url-scheme", route }, "[UrlScheme] unknown route");
		return;
	}
	handler(sub, params, deps, route);
}

function handlePingRoute(): void {
	logger.info({ src: "url-scheme" }, "[UrlScheme] ping ok");
}

function handleChatRoute(_sub: string, params: URLSearchParams, deps: UrlRouteDeps): void {
	deps.events.emit("ui:open-chat", {});
	const text = asString(params.get("text"));
	if (!text) return;
	broadcaster.broadcast("chatCommandRun", {
		command: { text, submit: asBool(params.get("submit")) },
	});
}

function handleSettingsRoute(_sub: string, params: URLSearchParams, deps: UrlRouteDeps): void {
	const tab = asString(params.get("tab"));
	if (openSettingsCompanion(tab)) return;
	deps.events.emit("ui:open-settings", {});
	broadcaster.broadcast("uiOpenSettings", tab ? { tab } : {});
}

const SWIFT_SETTINGS_TABS = new Set([
	"",
	"configuration:providers",
	"configuration:local-ai",
	"configuration:tray",
]);

function openSettingsCompanion(tab: string | undefined): boolean {
	const bridgePath = findBundledSettings();
	if (!bridgePath || (tab && !SWIFT_SETTINGS_TABS.has(tab))) return false;
	const binary = join(bridgePath, "Contents", "MacOS", "DetourSettings");
	if (!existsSync(binary)) return false;
	try {
		spawn(binary, [], { stdio: "ignore", detached: true }).unref();
		return true;
	} catch (err) {
		logger.warn({ src: "url-scheme", err }, "[UrlScheme] DetourSettings spawn failed; falling through");
		return false;
	}
}

function handleWindowRoute(_sub: string, params: URLSearchParams): void {
	const target = asString(params.get("target"));
	if (!target) return;
	if (target in BUNDLED_COMPANIONS) {
		const appPath = findBundledCompanion(target);
		const binName = BUNDLED_COMPANIONS[target]?.replace(/\.app$/, "");
		if (appPath && binName && spawnCompanion(appPath, binName)) return;
	}
	if (VALID_TARGETS.has(target as WindowOpenTarget)) {
		broadcaster.broadcast(`uiOpen${capitalize(target)}` as never, {});
	}
}

function handleLocalAiRoute(sub: string, params: URLSearchParams, _deps: UrlRouteDeps, route: string): void {
	const tier = route === "localchat" ? "chat" : "companion";
	if (sub !== "start" && sub !== "stop") {
		logger.warn({ src: "url-scheme", route, sub }, "[UrlScheme] local AI route requires start or stop");
		return;
	}
	const preset = asString(params.get("preset"));
	const body = sub === "start" && preset ? { preset } : {};
	void fetch(`http://127.0.0.1:2138/api/local-ai/${tier}/${sub}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	}).catch((err) => {
		logger.warn({ src: "url-scheme", route, sub, err }, "[UrlScheme] local AI fetch failed");
	});
}

function handlePensieveRoute(sub: string, params: URLSearchParams, deps: UrlRouteDeps): void {
	deps.events.emit("ui:open-pensieve", {});
	const q = asString(params.get("q"));
	if (sub === "search" && q) {
		broadcaster.broadcast("pensieveDeepLink" as never, { kind: "search", query: q });
	}
}

function handleActionRoute(_sub: string, params: URLSearchParams, deps: UrlRouteDeps): void {
	const name = asString(params.get("name"));
	if (!name) {
		logger.warn({ src: "url-scheme" }, "[UrlScheme] action route missing name");
		return;
	}
	void deps.core.rpcDeps.inbox
		.post({
			kind: "task",
			title: `[url-scheme] ${name}`,
			body: JSON.stringify({ action: name, params: actionParams(params) }),
			source: `url-scheme:${name}`,
			prompt: true,
			dedupeBySource: false,
		})
		.catch((err) => {
			logger.warn({ src: "url-scheme", name, err }, "[UrlScheme] inbox post failed");
		});
}

function actionParams(params: URLSearchParams): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of params) {
		if (key !== "name") result[key] = value;
	}
	return result;
}

function capitalize(s: string): string {
	if (!s) return s;
	// Special-case kebab → camel for "command-palette" → "CommandPalette".
	return s
		.split("-")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("");
}
