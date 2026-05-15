#!/usr/bin/env bun
/**
 * Bundle `coding-agent-adapters` + its transitive deps into the .app
 * so pty-manager's worker can `require('coding-agent-adapters')` at
 * runtime to register CLI adapters (Claude Code, Codex, Gemini, etc.).
 *
 * Without this, the bundled app has pty-manager but not its optional
 * adapter package, so `PTYService/Worker] Failed to register adapters:
 * Error: Cannot find module 'coding-agent-adapters'` fires on every
 * orchestrator spin-up and the agent's planner can't drive sub-agents.
 *
 * We can't add this with a static `build.copy` entry because the deps
 * tree (pino + ~10 transitive packages with version-pinned subdeps)
 * is bun-stage-shaped and would lock our config to specific versions.
 * Instead we walk the bun stage at `node_modules/.bun/coding-agent-adapters@<v>/`
 * — which already pins every dep to the right version via symlinks —
 * and produce a self-contained nested layout under
 * `node_modules/coding-agent-adapters/node_modules/<dep>/`.
 *
 * Skipped (already at bundle top-level): `adapter-types` ships next to
 * `pty-manager` via build.copy. Duplicating it under the nested tree
 * is harmless but wastes ~100KB; we let the walker include it for
 * resolution simplicity.
 */

import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	realpathSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const buildDir = process.env.ELECTROBUN_BUILD_DIR;
const appName = process.env.ELECTROBUN_APP_NAME ?? "Detour";
if (!buildDir) {
	console.error("[post-build-pty-adapters] ELECTROBUN_BUILD_DIR not set, skipping");
	process.exit(0);
}

const appPaths = [
	join(buildDir, `${appName}-dev.app`),
	join(buildDir, `${appName}.app`),
];
const appPath = appPaths.find((p) => existsSync(p));
if (!appPath) {
	console.error(`[post-build-pty-adapters] no .app at ${appPaths.join(" or ")}, skipping`);
	process.exit(0);
}

const bundleNm = join(appPath, "Contents/Resources/app/node_modules");
if (!existsSync(bundleNm)) {
	console.error(`[post-build-pty-adapters] ${bundleNm} missing, skipping`);
	process.exit(0);
}

const repoRoot = join(import.meta.dir, "..");
const bunStageRoot = join(repoRoot, "node_modules/.bun");
if (!existsSync(bunStageRoot)) {
	console.error(`[post-build-pty-adapters] ${bunStageRoot} missing — is bun install up to date?`);
	process.exit(1);
}

/** Locate the highest-version stage dir for a top-level package. */
function findRootStage(pkg: string): string {
	const stem = pkg.replace("/", "+"); // @pinojs/redact -> @pinojs+redact
	const candidates = readdirSync(bunStageRoot).filter((d) => d.startsWith(`${stem}@`));
	if (candidates.length === 0) {
		throw new Error(`no bun stage for ${pkg} under ${bunStageRoot}`);
	}
	candidates.sort();
	const last = candidates[candidates.length - 1]!;
	const inner = join(bunStageRoot, last, "node_modules", pkg);
	if (!existsSync(inner)) {
		throw new Error(`bun stage ${last} missing inner package at ${inner}`);
	}
	return inner;
}

/** Walks bun's per-stage `node_modules` and resolves every direct dep
 *  (which bun has symlinked to its version-pinned real dir). */
function collectDirectDeps(stagePackageDir: string): string[] {
	const stageNm = dirname(stagePackageDir); // .bun/<pkg>@<v>/node_modules
	if (!existsSync(stageNm)) return [];
	const out: string[] = [];
	for (const entry of readdirSync(stageNm)) {
		if (entry === basename(stagePackageDir)) continue; // skip the package itself
		if (entry === ".bin") continue;
		const entryPath = join(stageNm, entry);
		const stat = lstatSync(entryPath);
		if (entry.startsWith("@")) {
			// scoped: bun puts symlinks at .bun/<x>@<v>/node_modules/@scope/<name>
			if (!stat.isDirectory()) continue;
			for (const scoped of readdirSync(entryPath)) {
				const inner = join(entryPath, scoped);
				if (lstatSync(inner).isSymbolicLink()) {
					out.push(realpathSync(inner));
				}
			}
		} else if (stat.isSymbolicLink()) {
			out.push(realpathSync(entryPath));
		}
	}
	return out;
}

/** Derive the npm-style package name from a stage real path like
 *  `.bun/<pkg>@<ver>/node_modules/<pkg>` or
 *  `.bun/<scope+name>@<ver>/node_modules/<scope>/<name>`. */
function pkgNameFromStage(realPath: string): string {
	const parts = realPath.split("/");
	const nmIdx = parts.lastIndexOf("node_modules");
	if (nmIdx === -1) return basename(realPath);
	const after = parts.slice(nmIdx + 1);
	if (after[0]?.startsWith("@") && after.length >= 2) {
		return `${after[0]}/${after[1]}`;
	}
	return after[0] ?? basename(realPath);
}

const ROOT_PKG = "coding-agent-adapters";
const rootStage = findRootStage(ROOT_PKG);

const destRoot = join(bundleNm, ROOT_PKG);
const destNm = join(destRoot, "node_modules");

// Always start clean so partial copies from a failed run don't survive.
cpSync(rootStage, destRoot, { recursive: true, dereference: true, force: true });
mkdirSync(destNm, { recursive: true });

const visited = new Set<string>([ROOT_PKG]);
const queue: string[] = [rootStage];

let copied = 0;
while (queue.length > 0) {
	const stage = queue.shift()!;
	for (const dep of collectDirectDeps(stage)) {
		const name = pkgNameFromStage(dep);
		if (visited.has(name)) continue;
		visited.add(name);
		const dest = name.includes("/")
			? join(destNm, ...name.split("/"))
			: join(destNm, name);
		mkdirSync(dirname(dest), { recursive: true });
		cpSync(dep, dest, { recursive: true, dereference: true, force: true });
		queue.push(dep);
		copied += 1;
	}
}

console.log(
	`[post-build-pty-adapters] ${ROOT_PKG} + ${copied} transitive dep(s) staged at ${destRoot.replace(buildDir, "$BUILD")}`,
);
