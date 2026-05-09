import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

console.log("[main] starting");

// Cleanup hooks for graceful shutdown paths. Note: in the electrobun launcher
// context, SIGTERM/SIGINT/exit DO NOT reach Bun's listeners — the launcher
// inherits a signal disposition that drops them before JS dispatch. We still
// register handlers (using `prependListener` to win against eliza's runtime
// handlers in the rare case bun is run directly), but they're not the
// load-bearing cleanup path. Real cleanup for the llama subprocess is
// handled by:
//   1. A detached watchdog process that polls our pid and SIGKILLs llama
//      when we die — see LlamaServerService.spawnWatchdog().
//   2. A pidfile-based reaper at next startup — see LlamaServerService.reapOrphan().
type ShutdownHook = () => void;
const shutdownHooks: ShutdownHook[] = [];
let cleanupRan = false;
const runCleanup = (label: string) => {
	if (cleanupRan) return;
	cleanupRan = true;
	console.log(`[main] cleanup (${label})`);
	for (const hook of shutdownHooks) {
		try { hook(); } catch { /* best-effort */ }
	}
};
process.prependListener("SIGINT", () => { runCleanup("SIGINT"); process.exit(0); });
process.prependListener("SIGTERM", () => { runCleanup("SIGTERM"); process.exit(0); });
process.prependListener("SIGHUP", () => { runCleanup("SIGHUP"); process.exit(0); });
process.prependListener("exit", () => runCleanup("exit"));
process.prependListener("uncaughtException", (err) => {
	console.error("[main] uncaughtException:", err);
	runCleanup("uncaughtException");
	process.exit(1);
});
process.prependListener("unhandledRejection", (err) => {
	console.error("[main] unhandledRejection:", err);
	runCleanup("unhandledRejection");
	process.exit(1);
});

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
shutdownHooks.push(() => core.stop());
console.log(`[main] core listening on http://127.0.0.1:${core.port}`);

const { ApiClient } = await import("./kernel/api-client");
const api = new ApiClient(`http://127.0.0.1:${core.port}`);
await api.start();
shutdownHooks.unshift(() => api.stop()); // run api.stop() before core.stop()
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
const { portlessFeature } = await import("./features/portless");

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
	portlessFeature,
]);

console.log("[main] tray-app ready");
