/**
 * Pick the right URL for a tray window's React view.
 *
 *   - Default: `views://main/index.html#<route>` — Electrobun resolves
 *     `views://` against `Resources/app/views/`, where electrobun.config.ts
 *     copies the bundled view (electrobun dev AND build both produce this).
 *   - With DETOUR_DEV_URL set: use that as the base instead, with a hash
 *     route. Useful when you want a separate Vite dev server for hot
 *     reload (not the default — electrobun dev already rebuilds on save).
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const DEV_URL = process.env.DETOUR_DEV_URL ?? null;

let cachedBundledRoot: string | null | undefined;

function resolveBundledIndex(): string | null {
	if (cachedBundledRoot !== undefined) return cachedBundledRoot;
	if (DEV_URL) {
		// Explicit opt-in: use Vite (or whatever DETOUR_DEV_URL points at).
		cachedBundledRoot = null;
		return null;
	}
	const candidates = [
		// Bundled .app — process.execPath is .../Contents/MacOS/bun (or launcher)
		// and the Resources tree is at .../Contents/Resources/app/views/web/.
		process.execPath ? join(dirname(process.execPath), "..", "Resources", "app", "views", "main", "index.html") : null,
		process.execPath ? join(dirname(process.execPath), "views", "main", "index.html") : null,
	].filter((p): p is string => typeof p === "string" && p.length > 0);
	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			cachedBundledRoot = candidate;
			return candidate;
		}
	}
	cachedBundledRoot = null;
	return null;
}

/**
 * Resolve the URL for a Detour tray-window React view.
 *   resolveViewUrl()           → views://main/index.html      (chat)
 *   resolveViewUrl("activity") → views://main/activity.html
 *   resolveViewUrl("pensieve") → views://main/pensieve.html
 *   resolveViewUrl("browser")  → views://main/browser.html
 *   resolveViewUrl("channels") → views://main/channels.html
 *   resolveViewUrl("portless") → views://main/portless.html
 *
 * Each per-view HTML inlines `window.__detourView = "<view>"` before
 * loading the shared bundle (index.js / index.css), so React's entry
 * picks the right component synchronously. We use distinct file paths
 * (not URL fragments) because electrobun's views:// scheme handler
 * doesn't strip URL fragments and would 404 on `index.html#activity`.
 *
 * In DETOUR_DEV_URL mode we fall back to the URL-fragment form, which
 * is fine because a real HTTP server (e.g. Vite) handles fragments
 * correctly.
 */
export function resolveViewUrl(view?: string): string {
	const bundled = resolveBundledIndex();
	if (bundled) {
		const file = view ? `${view}.html` : "index.html";
		return `views://main/${file}`;
	}
	if (DEV_URL) {
		const fragment = view ? `#${view}` : "";
		return `${DEV_URL}/${fragment}`;
	}
	console.warn("[view-url] no bundled index.html found and no DETOUR_DEV_URL set — webview will be blank");
	const file = view ? `${view}.html` : "index.html";
	return `views://main/${file}`;
}
