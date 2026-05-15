/**
 * Pick the right URL for a tray window's React view.
 *
 *   - Default: `views://main/index.html` (and per-view `.html` files) —
 *     Electrobun resolves `views://` against `Resources/app/views/`,
 *     where electrobun.config.ts copies the bundled view (electrobun dev
 *     AND build both produce this).
 *   - With DETOUR_DEV_URL set: use that as the base, hitting per-view
 *     `.html` files (e.g. `${DEV_URL}/activity.html`). Required for
 *     Phantom OAuth: the WebView is served from a public HTTPS origin
 *     so Phantom's full-page redirect lands back in the same WebView
 *     with the SDK on it.
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
 *   resolveViewUrl("portless") → views://main/portless.html
 *   resolveViewUrl("gallery")  → views://main/gallery.html
 *
 * Each per-view HTML inlines `window.__detourView = "<view>"` before
 * loading the shared bundle (index.js / index.css), so React's entry
 * picks the right component synchronously. We use distinct file paths
 * (not URL fragments) because electrobun's views:// scheme handler
 * doesn't strip URL fragments and would 404 on `index.html#activity`.
 *
 * In DETOUR_DEV_URL mode we hit per-view `.html` files — the Vercel
 * deploy (or any static HTTP server) serves them at their literal paths,
 * and each per-view HTML inlines its own `window.__detourView = "<view>"`
 * before the shared JS bundle runs, so React picks the right component.
 */
export function resolveViewUrl(view?: string): string {
	const bundled = resolveBundledIndex();
	const file = view ? `${view}.html` : "index.html";
	if (bundled) {
		return `views://main/${file}`;
	}
	if (DEV_URL) {
		return `${DEV_URL}/${file}`;
	}
	console.warn("[view-url] no bundled index.html found and no DETOUR_DEV_URL set — webview will be blank");
	return `views://main/${file}`;
}
