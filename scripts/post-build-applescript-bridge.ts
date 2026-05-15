/**
 * Electrobun postBuild hook — compile DetourBridge.app and embed it
 * inside Detour.app/Contents/Resources/.
 *
 * DetourBridge is the Swift companion that gives Detour a working
 * AppleScript surface (`tell application id "ai.detour.bridge" to
 * ask agent "..."`). See docs/applescript.md and
 * build-assets/applescript-bridge/.
 *
 * The build is best-effort: if swiftc is missing (e.g. CI without
 * Xcode CLT) we log a warning and skip the bridge so the rest of the
 * Detour build still succeeds. Users without the bridge fall back to
 * the URL-scheme path via DetourHelpers.applescript.
 */

import { existsSync } from "node:fs";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const BRIDGE_DIR = join(REPO_ROOT, "build-assets", "applescript-bridge");
const BRIDGE_APP = join(BRIDGE_DIR, "DetourBridge.app");

const buildDir = process.env.ELECTROBUN_BUILD_DIR;
const appName = process.env.ELECTROBUN_APP_NAME;

if (!buildDir || !appName) {
	console.warn("[bridge] ELECTROBUN_BUILD_DIR / ELECTROBUN_APP_NAME unset; skipping");
	process.exit(0);
}

// Compile the bridge.
try {
	console.log("[bridge] running build.sh");
	execSync(`bash "${join(BRIDGE_DIR, "build.sh")}"`, { stdio: "inherit" });
} catch (err) {
	console.warn("[bridge] build failed; skipping bridge embed:", err instanceof Error ? err.message : err);
	// Non-fatal — Detour.app still builds. Users get the URL-scheme
	// path via DetourHelpers.applescript instead.
	process.exit(0);
}

if (!existsSync(BRIDGE_APP)) {
	console.warn(`[bridge] expected ${BRIDGE_APP}; not found, skipping embed`);
	process.exit(0);
}

// Copy DetourBridge.app into Detour.app/Contents/Resources/.
// Electrobun's build layout: ${ELECTROBUN_BUILD_DIR}/${APP_NAME}.app/.
const detourApp = join(buildDir, `${appName}.app`);
const target = join(detourApp, "Contents", "Resources", "DetourBridge.app");

if (!existsSync(detourApp)) {
	console.warn(`[bridge] expected ${detourApp}; not found, skipping embed`);
	process.exit(0);
}

console.log(`[bridge] embedding bridge into ${target}`);
rmSync(target, { recursive: true, force: true });
mkdirSync(join(target, ".."), { recursive: true });
cpSync(BRIDGE_APP, target, { recursive: true });

console.log("[bridge] done");
