/**
 * Electrobun postBuild hook — compile DetourTray.app and embed it
 * into Detour.app/Contents/Resources/. The Swift tray companion owns
 * the menu-bar NSStatusItem with a rich native NSMenu; the bun-side
 * tray-bridge feature spawns it on boot and disables Electrobun's
 * own tray so only one icon shows.
 *
 * Best-effort: if swiftc is missing we skip and fall back to
 * Electrobun's basic tray.
 */

import { existsSync } from "node:fs";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const BRIDGE_DIR = join(REPO_ROOT, "build-assets", "tray-bridge");
const BRIDGE_APP = join(BRIDGE_DIR, "DetourTray.app");

const buildDir = process.env.ELECTROBUN_BUILD_DIR;
const appName = process.env.ELECTROBUN_APP_NAME;

if (!buildDir || !appName) {
	console.warn("[tray] ELECTROBUN_BUILD_DIR / ELECTROBUN_APP_NAME unset; skipping");
	process.exit(0);
}

try {
	console.log("[tray] running build.sh");
	execSync(`bash "${join(BRIDGE_DIR, "build.sh")}"`, { stdio: "inherit" });
} catch (err) {
	console.warn(
		"[tray] build failed; skipping embed:",
		err instanceof Error ? err.message : err,
	);
	process.exit(0);
}

if (!existsSync(BRIDGE_APP)) {
	console.warn(`[tray] expected ${BRIDGE_APP}; not found, skipping embed`);
	process.exit(0);
}

const detourApp = join(buildDir, `${appName}.app`);
const target = join(detourApp, "Contents", "Resources", "DetourTray.app");

if (!existsSync(detourApp)) {
	console.warn(`[tray] expected ${detourApp}; not found, skipping`);
	process.exit(0);
}

console.log(`[tray] embedding tray into ${target}`);
rmSync(target, { recursive: true, force: true });
mkdirSync(join(target, ".."), { recursive: true });
cpSync(BRIDGE_APP, target, { recursive: true });
console.log("[tray] done");
