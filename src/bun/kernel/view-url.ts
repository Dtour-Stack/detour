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
 * Resolve the URL for a hash-routed React window.
 *   resolveViewUrl()           → chat (no hash)
 *   resolveViewUrl("pensieve") → "#pensieve"
 *   resolveViewUrl("activity") → "#activity"
 *   resolveViewUrl("channels") → "#channels"
 */
export function resolveViewUrl(hash?: string): string {
	const fragment = hash ? `#${hash}` : "";
	const bundled = resolveBundledIndex();
	if (bundled) {
		return `views://main/index.html${fragment}`;
	}
	if (DEV_URL) {
		return `${DEV_URL}/${fragment}`;
	}
	// Should be unreachable — bundled assets are produced by electrobun dev/build.
	// If we're here, something is wrong with the build artifact.
	console.warn("[view-url] no bundled index.html found and no DETOUR_DEV_URL set — webview will be blank");
	return `views://main/index.html${fragment}`;
}
