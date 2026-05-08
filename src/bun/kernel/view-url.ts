/**
 * Pick the right URL for a tray window's React view.
 *
 *   - In a packaged .app: `views://web/index.html#<route>` — Electrobun
 *     resolves `views://` against `Resources/app/views/`, where
 *     electrobun.config.ts copies the production Vite build (web/dist).
 *   - In dev: Vite dev server (default http://localhost:5180), with a hash
 *     route, so React's hash-based router mounts the right window.
 *
 * Detection: presence of the bundled index.html on disk. Reliable in both
 * `electrobun build` artifacts and `electrobun dev` (which still bundles).
 *
 * Override via DETOUR_DEV_URL if you want to force dev URL even with
 * bundled assets present (useful for hot-reload while shipping).
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const DEV_URL = process.env.DETOUR_DEV_URL ?? "http://localhost:5180";

let cachedBundledRoot: string | null | undefined;

function isDevBundle(): boolean {
	// Electrobun emits the dev .app at `Detour-dev.app` (build:dev) and prod
	// at `Detour.app` (build:canary / build:stable). When running from the
	// dev bundle we always prefer the live Vite server — hot reload trumps
	// the bundled assets.
	return typeof process.execPath === "string" && process.execPath.includes("Detour-dev.app/");
}

function resolveBundledIndex(): string | null {
	if (cachedBundledRoot !== undefined) return cachedBundledRoot;
	if (process.env.DETOUR_DEV_URL || isDevBundle()) {
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
 *   resolveViewUrl()           → chat (no hash)
 *   resolveViewUrl("pensieve") → "#pensieve"
 *   resolveViewUrl("activity") → "#activity"
 *   resolveViewUrl("channels") → "#channels"
 */
export function resolveViewUrl(hash?: string): string {
	const fragment = hash ? `#${hash}` : "";
	const bundled = resolveBundledIndex();
	if (bundled) {
		return `views://web/index.html${fragment}`;
	}
	return `${DEV_URL}/${fragment}`;
}
