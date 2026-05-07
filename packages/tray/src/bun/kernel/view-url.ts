/**
 * Pick the right URL for a tray window's React view.
 *
 *   - In a packaged .app: `views://web/index.html#<route>` — Electrobun
 *     resolves `views://` against `Resources/app/views/`, where
 *     electrobun.config.ts copies the production Vite build (web/dist).
 *   - In dev: the bundled React build, unless DETOUR_DEV_URL points at Vite.
 *
 * Detection: presence of the bundled index.html on disk. Reliable in both
 * `electrobun build` artifacts and `electrobun dev` (which still bundles).
 *
 * Override via DETOUR_DEV_URL when hot reload is worth the extra moving part.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const DEV_URL = process.env.DETOUR_DEV_URL ?? "http://localhost:5180";

let cachedBundledRoot: string | null | undefined;

function resolveBundledIndex(): string | null {
	if (cachedBundledRoot !== undefined) return cachedBundledRoot;
	if (process.env.DETOUR_DEV_URL) {
		cachedBundledRoot = null;
		return null;
	}
	const candidates = [
		// Bundled .app — process.execPath is .../Contents/MacOS/bun (or launcher)
		// and the Resources tree is at .../Contents/Resources/app/views/web/.
		process.execPath ? join(dirname(process.execPath), "..", "Resources", "app", "views", "web", "index.html") : null,
		process.execPath ? join(dirname(process.execPath), "views", "web", "index.html") : null,
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
 *   resolveViewUrl()           → chat
 *   resolveViewUrl("pensieve") → pensieve view
 *   resolveViewUrl("activity") → activity view
 *   resolveViewUrl("channels") → channels view
 */
export function resolveViewUrl(view?: string): string {
	const route = view ? `?view=${encodeURIComponent(view)}#${view}` : "";
	const bundled = resolveBundledIndex();
	if (bundled) {
		return `views://web/index.html${route}`;
	}
	return `${DEV_URL}/${route}`;
}
