/**
 * Electrobun postBuild hook — compile + embed DetourSettings.app, the
 * SwiftUI Settings companion. Mirrors post-build-{applescript,tray}-bridge.ts.
 */

import { existsSync } from "node:fs";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const BRIDGE_DIR = join(REPO_ROOT, "build-assets", "settings-bridge");
const BRIDGE_APP = join(BRIDGE_DIR, "DetourSettings.app");

const buildDir = process.env.ELECTROBUN_BUILD_DIR;
const appName = process.env.ELECTROBUN_APP_NAME;

if (!buildDir || !appName) {
	console.warn("[settings] ELECTROBUN_BUILD_DIR / ELECTROBUN_APP_NAME unset; skipping");
	process.exit(0);
}

try {
	console.log("[settings] running build.sh");
	execSync(`bash "${join(BRIDGE_DIR, "build.sh")}"`, { stdio: "inherit" });
} catch (err) {
	console.warn(
		"[settings] build failed; skipping embed:",
		err instanceof Error ? err.message : err,
	);
	process.exit(0);
}

if (!existsSync(BRIDGE_APP)) {
	console.warn(`[settings] expected ${BRIDGE_APP}; not found, skipping embed`);
	process.exit(0);
}

const detourApp = join(buildDir, `${appName}.app`);
const target = join(detourApp, "Contents", "Resources", "DetourSettings.app");

if (!existsSync(detourApp)) {
	console.warn(`[settings] expected ${detourApp}; not found, skipping`);
	process.exit(0);
}

console.log(`[settings] embedding settings into ${target}`);
rmSync(target, { recursive: true, force: true });
mkdirSync(join(target, ".."), { recursive: true });
cpSync(BRIDGE_APP, target, { recursive: true });
console.log("[settings] done");
