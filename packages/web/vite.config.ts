import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
	plugins: [react()],
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
