/**
 * postBuild hook — compile + embed DetourActivity.app. Same pattern
 * as the other Swift companion bridges. Best-effort.
 */

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const BRIDGE_DIR = join(REPO_ROOT, "build-assets", "activity-bridge");
const BRIDGE_APP = join(BRIDGE_DIR, "DetourActivity.app");

const buildDir = process.env.ELECTROBUN_BUILD_DIR;
const appName = process.env.ELECTROBUN_APP_NAME;
if (!buildDir || !appName) {
	console.warn("[activity] ELECTROBUN_BUILD_DIR / ELECTROBUN_APP_NAME unset; skipping");
	process.exit(0);
}

try {
	console.log("[activity] running build.sh");
	execSync(`bash "${join(BRIDGE_DIR, "build.sh")}"`, { stdio: "inherit" });
} catch (err) {
	console.warn("[activity] build failed; skipping embed:", err instanceof Error ? err.message : err);
	process.exit(0);
}

if (!existsSync(BRIDGE_APP)) {
	console.warn(`[activity] expected ${BRIDGE_APP}; not found, skipping`);
	process.exit(0);
}

const detourApp = join(buildDir, `${appName}.app`);
const target = join(detourApp, "Contents", "Resources", "DetourActivity.app");
if (!existsSync(detourApp)) {
	console.warn(`[activity] ${detourApp} missing, skipping`);
	process.exit(0);
}
rmSync(target, { recursive: true, force: true });
mkdirSync(join(target, ".."), { recursive: true });
cpSync(BRIDGE_APP, target, { recursive: true });
console.log(`[activity] embedded at ${target}`);
