import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "tray-app",
		identifier: "trayapp.electrobun.dev",
		version: "0.0.1",
	},
	runtime: {
		exitOnLastWindowClosed: false,
	},
	build: {
		bun: {
			entrypoint: "src/bun/index.ts",
		},
		views: {
			chat: {
				entrypoint: "src/features/chat/view/index.ts",
			},
			settings: {
				entrypoint: "src/features/settings/view/index.ts",
			},
		},
		copy: {
			"src/features/chat/view/index.html": "views/chat/index.html",
			"src/features/chat/view/index.css": "views/chat/index.css",
			"src/features/settings/view/index.html": "views/settings/index.html",
			"src/features/settings/view/index.css": "views/settings/index.css",
		},
		mac: {
			bundleCEF: false,
		},
		linux: {
			bundleCEF: false,
		},
		win: {
			bundleCEF: false,
		},
	},
} satisfies ElectrobunConfig;
