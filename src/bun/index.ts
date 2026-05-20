import Electrobun, { Utils } from "electrobun/bun";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "@elizaos/core";

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Electrobun often launches the Bun entry without Bun CLI’s automatic `.env`
 * merge. Load repo-root `.env` here; only sets keys that are still unset so
 * a parent shell can override.
 */
function loadRootDotEnv(): void {
	const path = join(import.meta.dir, "..", "..", ".env");
	if (!existsSync(path)) return;
	const text = readFileSync(path, "utf8");
	for (const line of text.split(/\r?\n/)) {
		const t = line.trim();
		if (!t || t.startsWith("#")) continue;
		const eq = t.indexOf("=");
		if (eq <= 0) continue;
		const key = t.slice(0, eq).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
		let val = t.slice(eq + 1).trim();
		if (
			(val.startsWith('"') && val.endsWith('"')) ||
			(val.startsWith("'") && val.endsWith("'"))
		) {
			val = val.slice(1, -1);
		}
		if (process.env[key] === undefined) process.env[key] = val;
	}
}

loadRootDotEnv();

logger.info({ src: "main" }, "[Main] starting");

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
type ShutdownHook = () => void | Promise<void>;
const shutdownHooks: ShutdownHook[] = [];
let cleanupPromise: Promise<void> | null = null;
const runCleanup = (label: string): Promise<void> => {
	if (cleanupPromise) return cleanupPromise;
	logger.info({ src: "main", label }, "[Main] cleanup");
	cleanupPromise = (async () => {
		for (const hook of shutdownHooks) {
			try { await hook(); } catch { /* best-effort */ }
		}
	})();
	return cleanupPromise;
};
Electrobun.events.on("before-quit", async () => { await runCleanup("before-quit"); });
process.prependListener("SIGINT", () => { void runCleanup("SIGINT").finally(() => Utils.quit()); });
process.prependListener("SIGTERM", () => { void runCleanup("SIGTERM").finally(() => Utils.quit()); });
process.prependListener("SIGHUP", () => { void runCleanup("SIGHUP").finally(() => Utils.quit()); });
process.prependListener("exit", () => { void runCleanup("exit"); });
process.prependListener("uncaughtException", (err) => {
	logger.error({ src: "main", err: errorMessage(err) }, "[Main] uncaughtException");
	void runCleanup("uncaughtException").finally(() => Utils.quit());
});
process.prependListener("unhandledRejection", (err) => {
	logger.error({ src: "main", err: errorMessage(err) }, "[Main] unhandledRejection");
	void runCleanup("unhandledRejection").finally(() => Utils.quit());
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
logger.info({ src: "main", dataDir }, "[Main] data dir ready");

logger.info({ src: "main" }, "[Main] booting core");
const { startCore } = await import("./core/index");
const core = await startCore({ dataDir, pgliteDataDir, port: 2138 });
shutdownHooks.push(() => core.stop());
logger.info({ src: "main", port: core.port }, "[Main] core listening");

const { createKernel } = await import("./kernel/app");
const { loadFeatures } = await import("./kernel/registry");
const { chatFeature } = await import("./features/chat");
const { settingsFeature } = await import("./features/settings");
const { pensieveFeature } = await import("./features/pensieve");
const { activityFeature } = await import("./features/activity");
const { browserFeature } = await import("./features/browser");
const { shortcutsFeature } = await import("./features/shortcuts");
const { notificationsFeature } = await import("./features/notifications");
const { menusFeature } = await import("./features/menus");
const { portlessFeature } = await import("./features/portless");
const { workspaceFeature } = await import("./features/workspace");
const { petFeature } = await import("./features/pet");
const { galleryFeature } = await import("./features/gallery");
const { trayPopoverFeature } = await import("./features/tray-popover");
const { urlSchemeFeature } = await import("./features/url-scheme");
const { statusWidgetFeature } = await import("./features/status-widget");
const { trayBridgeFeature } = await import("./features/tray-bridge");

logger.info({ src: "main" }, "[Main] creating kernel");
const kernel = createKernel({ trayTitle: "Detour", core });

logger.info({ src: "main" }, "[Main] loading features");
await loadFeatures(kernel, [
	// trayPopoverFeature MUST load before chatFeature so the popover
	// owns the tray-icon-click target. (Both register handlers on the
	// same event; the first to bind wins as the canonical menu.)
	trayPopoverFeature,
	urlSchemeFeature,
	chatFeature,
	settingsFeature,
	pensieveFeature,
	activityFeature,
	browserFeature,
	shortcutsFeature,
	notificationsFeature,
	menusFeature,
	portlessFeature,
	workspaceFeature,
	petFeature,
	galleryFeature,
	statusWidgetFeature,
	// trayBridgeFeature MUST load AFTER all features that addMenuItem,
	// so when it calls deps.tray.hideIcon() the registered items are
	// already collected (in case the Swift tray ever wants to fetch them).
	trayBridgeFeature,
]);

logger.info({ src: "main" }, "[Main] tray app ready");
