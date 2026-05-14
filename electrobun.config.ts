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
	scripts: {
		// Inject NSAppTransportSecurity localhost exception so the
		// workspace's WKWebView preview iframe can load
		// `http://<slug>.localhost:4848/` URLs from portless. Default
		// macOS WKWebView ATS rejects plain HTTP.
		postBuild: "scripts/post-build-ats.ts",
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
			// Runtime-loaded eliza skills and PTY peer packages. These are
			// resolved from disk by upstream packages via path/require probes.
			"eliza/packages/skills/skills": "eliza/packages/skills/skills",
			"node_modules/.bun/pty-manager@1.11.0/node_modules/pty-manager": "node_modules/pty-manager",
			"node_modules/.bun/node-pty@1.1.0/node_modules/node-pty": "node_modules/node-pty",
			"node_modules/.bun/adapter-types@0.2.0/node_modules/adapter-types": "node_modules/adapter-types",
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
			"src/main/pet.html": "views/main/pet.html",
			"src/main/portless.html": "views/main/portless.html",
			"src/main/workspace.html": "views/main/workspace.html",
			"src/main/gallery.html": "views/main/gallery.html",
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
	// release.baseUrl is required for the auto-updater to fetch the
	// previous version's update.json + tarball when generating an
	// incremental patch. Set DETOUR_RELEASE_BASE_URL to enable;
	// otherwise the field is omitted and electrobun skips patch
	// generation entirely (the .app/.dmg bundle still builds — they
	// just can't apply over an existing install).
	//
	// CI publishes full bundles to GitHub Releases without
	// patches, so it leaves this unset. Local devs can opt in by
	// exporting the env var.
	...(process.env.DETOUR_RELEASE_BASE_URL
		? { release: { baseUrl: process.env.DETOUR_RELEASE_BASE_URL } }
		: {}),
} satisfies ElectrobunConfig;
