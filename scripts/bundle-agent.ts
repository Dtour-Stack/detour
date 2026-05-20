#!/usr/bin/env bun
/**
 * bundle-agent.ts — produce the bun-runtime payload the Mac app ships,
 * WITHOUT going through electrobun.
 *
 * Replaces `electrobun build --env=dev` for the Mac-app build path.
 * Electrobun's other duties (React/WKWebView views, per-window companion
 * .app builds) aren't needed by the native Mac app, so they're skipped.
 *
 * Output layout (mirrors what build-mac-app.ts consumes):
 *   dist-agent/
 *     bun                   ← the bun runtime binary
 *     app/
 *       bun/
 *         index.js          ← bundled from src/bun/index.ts
 *         pglite.{data,wasm}
 *         initdb.wasm
 *         llama/            ← llama-server + dylibs + bundled embed model
 *       eliza/packages/skills/skills/
 *       knowledge/detour-squirrel/
 *       carrots/            ← bundled carrot plugins
 *       node_modules/{pty-manager,node-pty,adapter-types}/
 *       vector.tar.gz
 *       fuzzystrmatch.tar.gz
 *       Detour.sdef
 *       DetourHelpers.applescript
 *
 * Run:  bun run scripts/bundle-agent.ts
 * Or:   bun run build:agent
 */

import { build, type BuildConfig } from "bun";
import {
	cpSync,
	chmodSync,
	existsSync,
	mkdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const OUT = join(REPO_ROOT, "dist-agent");
const APP = join(OUT, "app");

function bail(msg: string): never {
	console.error(`[bundle-agent] ${msg}`);
	process.exit(1);
}

function ensure(path: string, label: string): void {
	if (!existsSync(path)) bail(`${label} missing: ${path}`);
}

function step(label: string, fn: () => void | Promise<void>): Promise<void> {
	const started = Date.now();
	console.log(`[bundle-agent] ${label}…`);
	const result = fn();
	const fin = (): void => {
		const ms = Date.now() - started;
		console.log(`[bundle-agent] ${label} (${ms}ms)`);
	};
	if (result instanceof Promise) return result.then(fin);
	fin();
	return Promise.resolve();
}

async function main(): Promise<void> {
	console.log(`[bundle-agent] output: ${OUT}`);
	rmSync(OUT, { recursive: true, force: true });
	mkdirSync(APP, { recursive: true });

	// 1. Bundle src/bun/index.ts → dist-agent/app/bun/index.js
	await step("bundling src/bun/index.ts", async () => {
		const entry = join(REPO_ROOT, "src", "bun", "index.ts");
		ensure(entry, "bun entrypoint");
		mkdirSync(join(APP, "bun"), { recursive: true });
		const stubPath = join(REPO_ROOT, "build-stubs", "davey-stub.js");
		const stubDaveyPlugin: NonNullable<BuildConfig["plugins"]>[number] = {
			name: "stub-davey",
			setup(b): void {
				if (!existsSync(stubPath)) return;
				b.onResolve({ filter: /^@snazzah\/davey$/ }, () => ({ path: stubPath }));
			},
		};
		const result = await build({
			entrypoints: [entry],
			outdir: join(APP, "bun"),
			target: "bun",
			format: "esm",
			naming: "[name].js",
			// No sourcemap in production — saved ~80MB. Re-enable via
			// DETOUR_AGENT_SOURCEMAP=1 if you need to debug the bundled
			// runtime.
			sourcemap: process.env.DETOUR_AGENT_SOURCEMAP ? "external" : "none",
			external: [
				"@node-llama-cpp/*",
				"node-llama-cpp",
				"nodejs-whisper",
				"whisper-node",
			],
			plugins: [stubDaveyPlugin],
		});
		if (!result.success) {
			bail(`bun.build failed: ${result.logs.map((l) => l.message).join("\n")}`);
		}
		const outFile = join(APP, "bun", "index.js");
		ensure(outFile, "bundler output");
		const sz = statSync(outFile).size;
		console.log(`[bundle-agent] index.js: ${(sz / 1024 / 1024).toFixed(1)} MB`);
	});

	// 2. Copy assets (mirrors what electrobun.config.ts copy: block did)
	await step("copying assets", async () => {
		const copy = (src: string, dst: string): void => {
			const fullSrc = join(REPO_ROOT, src);
			if (!existsSync(fullSrc)) {
				console.warn(`[bundle-agent]   skip (missing): ${src}`);
				return;
			}
			const fullDst = join(APP, dst);
			mkdirSync(join(fullDst, ".."), { recursive: true });
			cpSync(fullSrc, fullDst, { recursive: true });
		};
		// PGlite
		copy("build-assets/pglite/pglite.data", "bun/pglite.data");
		copy("build-assets/pglite/pglite.wasm", "bun/pglite.wasm");
		copy("build-assets/pglite/initdb.wasm", "bun/initdb.wasm");
		copy("build-assets/pglite/vector.tar.gz", "vector.tar.gz");
		copy("build-assets/pglite/fuzzystrmatch.tar.gz", "fuzzystrmatch.tar.gz");
		// llama-server + dylibs + bundled embedding model
		copy("build-assets/llama", "bun/llama");
		// Eliza skills (runtime-loaded by elizaOS plugins)
		copy("eliza/packages/skills/skills", "eliza/packages/skills/skills");
		// Bundled character knowledge
		copy("src/bun/core/knowledge/detour-squirrel", "knowledge/detour-squirrel");
		// Carrots (runtime-loaded sandboxed worker plugins)
		copy("carrots", "carrots");
		// Bundled Codex pet sprites — pet.json + spritesheet.webp per pet.
		// Lives under views/main/pets/ because the native PetSurface
		// (build-assets/swiftun-shell/Sources/Swiftun/PetSurface.swift) reads
		// from Bundle.main/Contents/Resources/app/views/main/pets/ — the
		// path was legacy-electrobun-flavored ("views://main/pets/<id>/...")
		// but never got renamed when PetSurface went native. Keep the path
		// so the PetSurface enumerator finds them.
		copy("build-assets/pets", "views/main/pets");
		// PTY adapter packages (runtime-resolved by coding-agent plugin)
		copy("node_modules/.bun/pty-manager@1.11.0/node_modules/pty-manager", "node_modules/pty-manager");
		copy("node_modules/.bun/node-pty@1.1.0/node_modules/node-pty", "node_modules/node-pty");
		copy("node_modules/.bun/adapter-types@0.2.0/node_modules/adapter-types", "node_modules/adapter-types");
		// AppleScript surface
		copy("build-assets/applescript/Detour.sdef", "Detour.sdef");
		copy("build-assets/applescript/DetourHelpers.applescript", "DetourHelpers.applescript");
	});

	// 3. Copy the bun binary. Prefer electrobun's vendored copy (matched
	//    to the version this project tests against); fall back to the
	//    @oven/bun-darwin-aarch64 npm package.
	await step("copying bun runtime binary", async () => {
		const candidates = [
			join(REPO_ROOT, "node_modules/.bun/electrobun@1.18.1/node_modules/electrobun/dist-macos-arm64/bun"),
			join(REPO_ROOT, "node_modules/.bun/@oven+bun-darwin-aarch64@1.3.13/node_modules/@oven/bun-darwin-aarch64/bin/bun"),
		];
		for (const src of candidates) {
			if (existsSync(src)) {
				const dst = join(OUT, "bun");
				cpSync(src, dst);
				chmodSync(dst, 0o755);
				console.log(`[bundle-agent]   bun ← ${src.replace(REPO_ROOT + "/", "")}`);
				return;
			}
		}
		bail(`bun runtime not found in: ${candidates.join("\n  ")}`);
	});

	// 4. Run any agent-payload post-build hook (PTY adapters bundling,
	//    eliza payload patches). The script chain is invoked with the
	//    DETOUR_AGENT_BUILD_DIR env var so it can find our output.
	await step("running post-build-pty-adapters", async () => {
		process.env.DETOUR_AGENT_BUILD_DIR = OUT;
		process.env.ELECTROBUN_BUILD_DIR = join(OUT); // legacy alias for compatibility
		try {
			await import("./post-build-pty-adapters");
		} catch (err) {
			console.warn(`[bundle-agent]   post-build-pty-adapters: ${err instanceof Error ? err.message : err}`);
		}
	});

	console.log(`[bundle-agent] done → ${OUT}`);
	console.log(`[bundle-agent] next: bun run build:mac  (consumes dist-agent/)`);
}

await main();
