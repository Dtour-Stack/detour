import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `base: "./"` makes the prod build emit RELATIVE asset URLs (e.g.
// `assets/index-xxx.js`) so the bundled HTML works when loaded from a
// `views://` URI inside the .app bundle (where there's no real web origin).
// Without this, asset URLs are absolute (`/assets/...`) and 404 inside
// Electrobun's webview file context.
export default defineConfig({
	plugins: [react()],
	base: "./",
	server: {
		port: 5180,
		proxy: {
			"/api": "http://127.0.0.1:2138",
			"/ws": {
				target: "ws://127.0.0.1:2138",
				ws: true,
			},
		},
	},
});
