import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

console.log("[main] starting");

// Detour's canonical home dir. Everything in core/cli/plugins hardcodes
// `homedir() + ".detour"` for cron, logs, skills, workspace, runtime lock,
// audit, etc. — so dataDir matches. Vault, eliza-db, gateway, inbox, llama,
// audit, action-results live here too.
//
// Auth (Anthropic OAuth, Codex OAuth) is shared with the user's other eliza
// apps via a symlink: ~/.detour/auth → ~/.eliza/auth. The eliza submodule's
// listAccounts() reads <ELIZA_STATE_DIR>/auth/<provider>/*.json which
// resolves through the symlink to the shared store.
const dataDir = join(homedir(), ".detour");
mkdirSync(dataDir, { recursive: true });
const pgliteDataDir = join(dataDir, "eliza-db");
console.log(`[main] dataDir=${dataDir}`);

console.log("[main] booting core (in-process)");
const { startCore } = await import("./core/index");
const core = await startCore({ dataDir, pgliteDataDir, port: 2138 });
console.log(`[main] core listening on http://127.0.0.1:${core.port}`);

const { ApiClient } = await import("./kernel/api-client");
const api = new ApiClient(`http://127.0.0.1:${core.port}`);
await api.start();
console.log("[main] api client connected");

const { createKernel } = await import("./kernel/app");
const { loadFeatures } = await import("./kernel/registry");
const { chatFeature } = await import("./features/chat");
const { settingsFeature } = await import("./features/settings");
const { pensieveFeature } = await import("./features/pensieve");
const { activityFeature } = await import("./features/activity");
const { browserFeature } = await import("./features/browser");
const { channelsFeature } = await import("./features/channels");
const { shortcutsFeature } = await import("./features/shortcuts");
const { notificationsFeature } = await import("./features/notifications");
const { menusFeature } = await import("./features/menus");

console.log("[main] creating kernel");
const kernel = createKernel({ trayTitle: "Detour", core, api });

console.log("[main] loading features");
await loadFeatures(kernel, [
	chatFeature,
	settingsFeature,
	pensieveFeature,
	activityFeature,
	browserFeature,
	channelsFeature,
	shortcutsFeature,
	notificationsFeature,
	menusFeature,
]);

console.log("[main] tray-app ready");

// Cleanup on every shutdown path — including tray-menu Quit (which fires
// `process.exit(0)` directly, bypassing signal handlers) and uncaught errors.
// `exit` fires synchronously for all of those; `core.stop()` is sync-safe and
// kills the spawned llama-server child so we don't accumulate orphans.
let cleanupRan = false;
const cleanup = () => {
	if (cleanupRan) return;
	cleanupRan = true;
	try { api.stop(); } catch {}
	try { core.stop(); } catch {}
};
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });
process.on("exit", cleanup);
// SIGHUP fires when the controlling terminal closes (e.g. `bun start` parent
// shell quits without the user explicitly stopping us). Without this, the
// llama child gets reparented to launchd and lingers.
process.on("SIGHUP", () => { cleanup(); process.exit(0); });
