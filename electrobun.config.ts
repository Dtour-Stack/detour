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

// `app.version` is sourced from this package's package.json so release tooling
// (release-please) only has to bump one place. CI replaces this value during
// release builds; dev mode just uses whatever's checked in.
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
			// node-llama-cpp (transitive dep of @elizaos/plugin-local-embedding)
			// references platform-specific binding subpackages (@node-llama-cpp/win-*,
			// linux-*, etc.) that aren't installed because they're only needed on
			// those platforms. Mark them external so the bundler skips resolution;
			// at runtime the platform-detection code finds the right one for darwin.
			// External all platform-specific node-llama-cpp variants and other
			// llama.cpp/whisper native deps. We don't actually use llama.cpp
			// for inference (only for embeddings via transformers.js). At runtime
			// these imports fail gracefully — the plugin's platform detector
			// catches the missing binding and falls back to wasm/onnx.
			external: [
				"@node-llama-cpp/*",
				"node-llama-cpp",
				"nodejs-whisper",
				"whisper-node",
			],
		},
		// No bundled view entrypoints — the chat window loads the React app
		// from the Vite dev server (or built /web/dist in production).
		views: {},
		copy: {
			// Tray icons (template PNGs). Electrobun's Tray API resolves the
			// `image` path against the views folder when prefixed with views://,
			// so place them at Resources/app/views/icons/ and reference as
			// `views://icons/iconTemplate.png` in tray.ts.
			"build-assets/tray/iconTemplate.png": "views/icons/iconTemplate.png",
			"build-assets/tray/iconTemplate@2x.png": "views/icons/iconTemplate@2x.png",
			"build-assets/tray/iconTemplate@3x.png": "views/icons/iconTemplate@3x.png",
			// PGlite WASM/data go alongside Resources/app/bun/index.js;
			// extension bundles live one directory up at Resources/app/ root
			// (the bundled importExtensionBundle helper looks there).
			"build-assets/pglite/pglite.data": "bun/pglite.data",
			"build-assets/pglite/pglite.wasm": "bun/pglite.wasm",
			"build-assets/pglite/initdb.wasm": "bun/initdb.wasm",
			"build-assets/pglite/vector.tar.gz": "vector.tar.gz",
			"build-assets/pglite/fuzzystrmatch.tar.gz": "fuzzystrmatch.tar.gz",
			// llama.cpp prebuilt server + dylibs (downloaded by
			// scripts/prepare-llama-assets.ts at the LLAMA_TAG pin).
			// Co-located in `bun/llama/` so the binary's @rpath finds the
			// dylibs at runtime. LlamaServerService spawns
			// `bun/llama/llama-server` for embeddings (and later, optional
			// local chat completion).
			"build-assets/llama": "bun/llama",
			"../core/src/knowledge/detour-squirrel": "knowledge/detour-squirrel",
			// Production React build for canary/stable. Copied into
			// `Resources/app/views/web/` so resolveViewUrl() can target
			// `views://web/index.html#<route>` when running outside dev.
			// Dev builds skip this copy intentionally — dev windows continue
			// to point at the live Vite dev server (http://localhost:5180)
			// for hot-reload. The kernel's resolveViewUrl helper falls back
			// to the dev URL when the bundled index.html isn't present.
			"../web/dist": "views/web",
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
