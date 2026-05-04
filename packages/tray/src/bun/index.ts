import { Utils } from "electrobun/bun";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

console.log("[main] starting");

const dataDir = Utils.paths.userData;
mkdirSync(dataDir, { recursive: true });
const pgliteDataDir = join(dataDir, "eliza-db");
console.log(`[main] dataDir=${dataDir}`);

console.log("[main] booting core (in-process)");
const { startCore } = await import("@detour/core");
const core = await startCore({ pgliteDataDir, port: 2138 });
console.log(`[main] core listening on http://127.0.0.1:${core.port}`);

const { ApiClient } = await import("./kernel/api-client");
const api = new ApiClient(`http://127.0.0.1:${core.port}`);
await api.start();
console.log("[main] api client connected");

const { createKernel } = await import("./kernel/app");
const { loadFeatures } = await import("./kernel/registry");
const { chatFeature } = await import("../features/chat/bun");
const { settingsFeature } = await import("../features/settings/bun");
const { shortcutsFeature } = await import("../features/shortcuts/bun");
const { notificationsFeature } = await import("../features/notifications/bun");
const { menusFeature } = await import("../features/menus/bun");

console.log("[main] creating kernel");
const kernel = createKernel({ trayTitle: "Detour", core, api });

console.log("[main] loading features");
await loadFeatures(kernel, [
	chatFeature,
	settingsFeature,
	shortcutsFeature,
	notificationsFeature,
	menusFeature,
]);

console.log("[main] tray-app ready");

const cleanup = () => {
	api.stop();
	core.stop();
	process.exit(0);
};
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
