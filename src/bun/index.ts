import Electrobun, { Utils } from "electrobun/bun";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

console.log("[main] starting");

// Shutdown hooks. Canonical Electrobun pattern is `before-quit` for async
// cleanup — see .claude/rules/electrobun.md ("Use `before-quit` for async
// shutdown cleanup — never rely on `process.on(\"exit\")` for async work").
//
// We register the standard Electrobun event AND keep process.* listeners
// as fallbacks for direct-bun execution (no launcher) and for unhandled
// errors. The launcher swallows SIGTERM/SIGINT before Bun dispatches them,
// so for hard kills we additionally rely on:
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
Electrobun.events.on("before-quit", () => runCleanup("before-quit"));
process.prependListener("SIGINT", () => { runCleanup("SIGINT"); Utils.quit(); });
process.prependListener("SIGTERM", () => { runCleanup("SIGTERM"); Utils.quit(); });
process.prependListener("SIGHUP", () => { runCleanup("SIGHUP"); Utils.quit(); });
process.prependListener("exit", () => runCleanup("exit"));
process.prependListener("uncaughtException", (err) => {
	console.error("[main] uncaughtException:", err);
	runCleanup("uncaughtException");
	Utils.quit();
});
process.prependListener("unhandledRejection", (err) => {
	console.error("[main] unhandledRejection:", err);
	runCleanup("unhandledRejection");
	Utils.quit();
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
const kernel = createKernel({ trayTitle: "Detour", core });

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
