import type { ElectrobunConfig } from "electrobun";
import { resolve } from "node:path";
import pkg from "./package.json" with { type: "json" };

// Bun bundler plugin: replace @snazzah/davey (Discord voice DAVE protocol
// native binding) with a no-op stub. The real package can't be bundled into
// a single .app because its loader uses createRequire to find platform
// subpackages by name, which fails post-bundling. We don't ship voice
// features — text messaging is the goal — so the stub satisfies the
// import-time surface and discord plugin loads cleanly.
const stubDaveyPlugin = {
	name: "stub-davey",
	setup(build: { onResolve: (opts: { filter: RegExp }, fn: (args: unknown) => { path: string }) => void }) {
		const stubPath = resolve(import.meta.dir, "build-stubs/davey-stub.js");
		build.onResolve({ filter: /^@snazzah\/davey$/ }, () => ({ path: stubPath }));
	},
};

export default {
	app: {
		name: "Detour",
		identifier: "ai.detour.app",
		version: pkg.version,
	},
	runtime: {
		exitOnLastWindowClosed: false,
	},
	build: {
		bun: {
			entrypoint: "src/bun/index.ts",
			plugins: [stubDaveyPlugin],
			external: [
				"@node-llama-cpp/*",
				"node-llama-cpp",
				"nodejs-whisper",
				"whisper-node",
			],
		},
		// Single React entrypoint that routes per-view internally via
		// `?view=<name>#<name>` URL fragments. Electrobun bundles this into
		// Resources/app/views/main/index.html which view-url.ts targets as
		// `views://main/index.html?view=X#X`.
		views: {
			main: {
				entrypoint: "src/views/_shared/main.tsx",
			},
		},
		copy: {
			// Tray icons (template PNGs). Resolved as `views://icons/iconTemplate.png` in tray.ts.
			"build-assets/tray/iconTemplate.png": "views/icons/iconTemplate.png",
			"build-assets/tray/iconTemplate@2x.png": "views/icons/iconTemplate@2x.png",
			"build-assets/tray/iconTemplate@3x.png": "views/icons/iconTemplate@3x.png",
			// PGlite WASM/data alongside Resources/app/bun/index.js.
			"build-assets/pglite/pglite.data": "bun/pglite.data",
			"build-assets/pglite/pglite.wasm": "bun/pglite.wasm",
			"build-assets/pglite/initdb.wasm": "bun/initdb.wasm",
			"build-assets/pglite/vector.tar.gz": "vector.tar.gz",
			"build-assets/pglite/fuzzystrmatch.tar.gz": "fuzzystrmatch.tar.gz",
			// llama.cpp prebuilt server + dylibs.
			"build-assets/llama": "bun/llama",
			// Character knowledge bundled with the app, surfaced via
			// resolveBundledIndex() / KnowledgeService.
			"src/bun/core/knowledge/detour-squirrel": "knowledge/detour-squirrel",
			// HTML shell for the single React entrypoint. Loaded by the tray as
			// `views://main/index.html`. Sources main.js + main.css from the same
			// directory (electrobun's view bundler emits those alongside).
			"src/views/_shared/index.html": "views/main/index.html",
		},
		mac: {
			bundleCEF: false,
			icons: "build-assets/app-icon/icon.iconset",
		},
		linux: {
			bundleCEF: false,
		},
		win: {
			bundleCEF: false,
		},
	},
} satisfies ElectrobunConfig;
