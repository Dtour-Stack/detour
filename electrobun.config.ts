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
				entrypoint: "src/main/index.tsx",
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
			// HTML shells for the single React entrypoint. Each window loads
			// its own per-view HTML that sets window.__detourView before the
			// shared bundle runs — this avoids electrobun's views:// scheme
			// handler choking on URL fragments (it doesn't strip them, so
			// `views://main/index.html#activity` would 404 looking for a
			// file literally named index.html#activity). All HTMLs reference
			// the same index.js + index.css siblings.
			"src/main/index.html": "views/main/index.html",
			"src/main/activity.html": "views/main/activity.html",
			"src/main/pensieve.html": "views/main/pensieve.html",
			"src/main/browser.html": "views/main/browser.html",
			"src/main/channels.html": "views/main/channels.html",
			"src/main/portless.html": "views/main/portless.html",
			// Carrot bridge — runtime-loaded plugins. Workers spawn from disk
			// (Bun.Worker reads .ts source directly). Worker import of the SDK
			// resolves via the path-preserving copy of carrot-sdk/index.ts, so
			// the same import statement works in dev source and bundled .app.
			// See src/bun/core/carrots/ for the host bridge.
			"carrots/cron-tools": "carrots/cron-tools",
			"src/bun/carrot-sdk/index.ts": "src/bun/carrot-sdk/index.ts",
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
