/**
 * postBuild hook — compile + embed DetourWorkspace.app.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const BRIDGE_DIR = join(REPO_ROOT, "build-assets", "workspace-bridge");
const BRIDGE_APP = join(BRIDGE_DIR, "DetourWorkspace.app");

const buildDir = process.env.ELECTROBUN_BUILD_DIR;
const appName = process.env.ELECTROBUN_APP_NAME;
if (!buildDir || !appName) {
	console.warn("[workspace] ELECTROBUN_BUILD_DIR / ELECTROBUN_APP_NAME unset; skipping");
	process.exit(0);
}
try {
	console.log("[workspace] running build.sh");
	execSync(`bash "${join(BRIDGE_DIR, "build.sh")}"`, { stdio: "inherit" });
} catch (err) {
	console.warn("[workspace] build failed:", err instanceof Error ? err.message : err);
	process.exit(0);
}
if (!existsSync(BRIDGE_APP)) {
	console.warn(`[workspace] expected ${BRIDGE_APP}; not found`);
	process.exit(0);
}
const detourApp = join(buildDir, `${appName}.app`);
const target = join(detourApp, "Contents", "Resources", "DetourWorkspace.app");
if (!existsSync(detourApp)) {
	console.warn(`[workspace] ${detourApp} missing`);
	process.exit(0);
}
rmSync(target, { recursive: true, force: true });
mkdirSync(join(target, ".."), { recursive: true });
cpSync(BRIDGE_APP, target, { recursive: true });
console.log(`[workspace] embedded at ${target}`);
