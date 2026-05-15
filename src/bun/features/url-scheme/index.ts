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
 * Locate the embedded DetourSettings.app inside our own bundle. The
 * postBuild hook drops it at Resources/DetourSettings.app. Returns
 * null in dev source mode (no bundle yet) so the React Settings
 * drawer stays as the fallback.
 */
function findBundledSettings(): string | null {
	if (!process.execPath) return null;
	const candidates = [
		join(
			dirname(process.execPath),
			"..",
			"Resources",
			"app",
			"DetourSettings.app",
		),
		join(
			dirname(process.execPath),
			"..",
			"Resources",
			"DetourSettings.app",
		),
	];
	for (const c of candidates) if (existsSync(c)) return c;
	return null;
}

function registerBridgeWithLaunchServices(): void {
	const bridgePath = findBundledBridge();
	if (!bridgePath) {
		console.log("[url-scheme] DetourBridge.app not bundled — skipping LS registration");
		return;
	}
	// `lsregister` lives at a deep system path; -f forces re-registration
	// (idempotent if already registered to the same bundle path).
	const lsregister =
		"/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
	if (!existsSync(lsregister)) {
		console.warn("[url-scheme] lsregister not found; skipping bridge registration");
		return;
	}
	const child = spawn(lsregister, ["-f", bridgePath], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.once("close", (code) => {
		if (code === 0) {
			console.log(`[url-scheme] registered DetourBridge.app at ${bridgePath}`);
		} else {
			console.warn(`[url-scheme] lsregister exited ${code}`);
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

export const urlSchemeFeature: Feature = {
	id: "url-scheme",
	init(deps) {
		// Register the embedded AppleScript bridge with LaunchServices
		// so `tell application id "ai.detour.bridge" to ...` works
		// without manual setup. Idempotent — re-runs on every Detour
		// launch but only does I/O on first install / bundle move.
		try {
			registerBridgeWithLaunchServices();
		} catch (err) {
			console.warn("[url-scheme] bridge registration failed:", err);
		}
		Electrobun.events.on("open-url", (e: { data: { url: string } }) => {
			const raw = e?.data?.url ?? "";
			if (!raw.startsWith("detour:")) return;
			const url = parseUrl(raw);
			if (!url) {
				console.warn(`[url-scheme] could not parse: ${raw}`);
				return;
			}
			// URL.host carries the route name (`detour://chat?...`),
			// not the path. `detour://pensieve/search?q=x` would split
			// host=pensieve + pathname=/search.
			const route = (url.host || "").toLowerCase();
			const sub = url.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
			const params = url.searchParams;
			console.log(`[url-scheme] route=${route} sub=${sub} params=${params}`);
			try {
				handleRoute(route, sub, params, deps);
			} catch (err) {
				console.warn("[url-scheme] handler failed:", err);
			}
		});
	},
};

function handleRoute(
	route: string,
	sub: string,
	params: URLSearchParams,
	deps: Parameters<Feature["init"]>[0],
): void {
	switch (route) {
		case "ping":
			console.log("[url-scheme] ping → ok");
			return;

		case "chat": {
			deps.events.emit("ui:open-chat", {});
			const text = asString(params.get("text"));
			if (text) {
				broadcaster.broadcast("chatCommandRun", {
					command: { text, submit: asBool(params.get("submit")) },
				});
			}
			return;
		}

		case "settings": {
			const tab = asString(params.get("tab"));
			// Prefer the SwiftUI DetourSettings.app companion when bundled.
			// Tabs DetourSettings doesn't cover yet fall through to the
			// React drawer (its label-only entries broadcast back with a
			// deep-link via uiOpenSettings, the legacy path).
			const SWIFT_TABS = new Set([
				"",
				"configuration:providers",
				"configuration:local-ai",
				"configuration:tray",
			]);
			const bridgePath = findBundledSettings();
			if (bridgePath && (!tab || SWIFT_TABS.has(tab))) {
				const binary = join(bridgePath, "Contents", "MacOS", "DetourSettings");
				if (existsSync(binary)) {
					try {
						spawn(binary, [], { stdio: "ignore", detached: true }).unref();
						return;
					} catch (err) {
						console.warn("[url-scheme] DetourSettings spawn failed, falling through:", err);
					}
				}
			}
			deps.events.emit("ui:open-settings", {});
			broadcaster.broadcast("uiOpenSettings", tab ? { tab } : {});
			return;
		}

		case "window": {
			const target = asString(params.get("target"));
			// `target=settings` short-circuits to the SwiftUI window when
			// bundled — keeps menu / Shortcut / AppleScript callers
			// consistent with the dedicated `detour://settings` route.
			if (target === "settings") {
				const bridgePath = findBundledSettings();
				if (bridgePath) {
					const binary = join(
						bridgePath,
						"Contents",
						"MacOS",
						"DetourSettings",
					);
					if (existsSync(binary)) {
						try {
							spawn(binary, [], { stdio: "ignore", detached: true }).unref();
							return;
						} catch (err) {
							console.warn(
								"[url-scheme] DetourSettings spawn failed, falling through:",
								err,
							);
						}
					}
				}
			}
			if (target && VALID_TARGETS.has(target as WindowOpenTarget)) {
				broadcaster.broadcast(`uiOpen${capitalize(target)}` as never, {});
			}
			return;
		}

		case "localchat":
		case "companion": {
			// detour://localchat/start?preset=… / detour://localchat/stop
			// detour://companion/start?preset=… / detour://companion/stop
			// Routes back into the same HTTP /api/local-ai/*/{start,stop}
			// endpoint via localhost so we have ONE code path that
			// validates + drives the service.
			const tier = route === "localchat" ? "chat" : "companion";
			if (sub !== "start" && sub !== "stop") {
				console.warn(`[url-scheme] /${route} requires /start or /stop`);
				return;
			}
			const preset = asString(params.get("preset"));
			const body = sub === "start" && preset ? { preset } : {};
			void fetch(`http://127.0.0.1:2138/api/local-ai/${tier}/${sub}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}).catch((err) => {
				console.warn(`[url-scheme] /${route}/${sub} fetch failed:`, err);
			});
			return;
		}

		case "pensieve": {
			deps.events.emit("ui:open-pensieve", {});
			const q = asString(params.get("q"));
			if (sub === "search" && q) {
				// Pensieve listens for this broadcast and runs the search
				// when its view mounts.
				broadcaster.broadcast(
					"pensieveDeepLink" as never,
					{ kind: "search", query: q },
				);
			}
			return;
		}

		case "action": {
			const name = asString(params.get("name"));
			if (!name) {
				console.warn("[url-scheme] /action missing `name`");
				return;
			}
			const actionParams: Record<string, string> = {};
			for (const [k, v] of params) {
				if (k === "name") continue;
				actionParams[k] = v;
			}
			// Queue through the inbox pipeline so the agent processes it
			// like any external trigger. The handler reads the JSON body
			// and dispatches to the named action.
			const body = JSON.stringify({ action: name, params: actionParams });
			void deps.core.rpcDeps.inbox
				.post({
					kind: "task",
					title: `[url-scheme] ${name}`,
					body,
					source: `url-scheme:${name}`,
					prompt: true,
					dedupeBySource: false,
				})
				.catch((err) => {
					console.warn(`[url-scheme] inbox.post failed:`, err);
				});
			return;
		}

		default:
			console.warn(`[url-scheme] unknown route: detour://${route}`);
	}
}

function capitalize(s: string): string {
	if (!s) return s;
	// Special-case kebab → camel for "command-palette" → "CommandPalette".
	return s
		.split("-")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("");
}
