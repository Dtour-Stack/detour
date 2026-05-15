/**
 * Tray-bridge feature — spawns DetourTray.app (the Swift companion
 * that owns the menu-bar NSStatusItem with a rich native NSMenu) and
 * hides Electrobun's basic tray so only one icon shows.
 *
 * Lifecycle:
 *   - On Detour boot: locate the embedded DetourTray.app, register it
 *     with LaunchServices (idempotent), launch it once.
 *   - The Swift tray polls Detour's /api/tray-state every 4s; if
 *     Detour stops responding for 30s it self-exits, so no orphan
 *     icon remains after a Detour crash.
 *   - Detour shutdown (before-quit hook) sends a SIGTERM to the
 *     tray's pid for prompt cleanup.
 *
 * Fallback: when DetourTray.app isn't bundled (e.g. swiftc missing
 * at build time and the postBuild hook skipped), this feature is a
 * no-op and Electrobun's basic tray stays visible.
 */

import Electrobun from "electrobun/bun";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Feature } from "../../kernel/registry";

function findBundledTray(): string | null {
	if (!process.execPath) return null;
	const candidates = [
		join(
			dirname(process.execPath),
			"..",
			"Resources",
			"app",
			"DetourTray.app",
		),
		join(
			dirname(process.execPath),
			"..",
			"Resources",
			"DetourTray.app",
		),
	];
	for (const c of candidates) if (existsSync(c)) return c;
	return null;
}

function registerWithLaunchServices(appPath: string): void {
	const lsregister =
		"/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
	if (!existsSync(lsregister)) return;
	try {
		const child = spawn(lsregister, ["-f", appPath], { stdio: "ignore" });
		child.unref();
	} catch {
		/* best-effort */
	}
}

export const trayBridgeFeature: Feature = {
	id: "tray-bridge",
	init(deps) {
		if (process.platform !== "darwin") return;

		const trayApp = findBundledTray();
		if (!trayApp) {
			console.log("[tray-bridge] DetourTray.app not bundled; keeping Electrobun tray");
			return;
		}

		// Hide Electrobun's tray icon — the Swift companion takes over.
		deps.tray.hideIcon();

		// Register + launch.
		registerWithLaunchServices(trayApp);
		const binary = join(trayApp, "Contents", "MacOS", "DetourTray");
		if (!existsSync(binary)) {
			console.warn(`[tray-bridge] DetourTray binary missing at ${binary}`);
			return;
		}
		let child: ChildProcess | null = null;
		try {
			child = spawn(binary, [], {
				stdio: "ignore",
				detached: true,
			});
			child.unref();
			console.log(`[tray-bridge] launched DetourTray (pid=${child.pid})`);
		} catch (err) {
			console.warn("[tray-bridge] failed to launch DetourTray:", err);
			return;
		}

		// On Detour quit, ask the tray to exit promptly (it would
		// auto-exit after 30s of unreachability anyway).
		Electrobun.events.on("before-quit", () => {
			if (child?.pid) {
				try {
					process.kill(child.pid, "SIGTERM");
				} catch {
					/* already gone */
				}
			}
		});
	},
};
