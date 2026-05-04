import type { ElectrobunConfig } from "electrobun";
import pkg from "./package.json" with { type: "json" };

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
