import { ApplicationMenu, Utils } from "electrobun/bun";
import { logger } from "@elizaos/core";
import type { Feature } from "../../kernel/registry";
import { GLOBAL_SHORTCUTS, WINDOW_TARGET_META } from "../../../shared/window-targets";

/**
 * Relaunch the app by detaching a fresh copy of the same invocation
 * (process.execPath + argv) and then quitting the current process.
 * Works in both `bun start` (dev) and the packaged binary because in
 * either case argv[0] is the binary that knows how to launch us.
 */
function relaunch(): void {
	try {
		const proc = Bun.spawn({
			cmd: [process.execPath, ...process.argv.slice(1)],
			stdio: ["ignore", "ignore", "ignore"],
			cwd: process.cwd(),
			env: { ...process.env },
		});
		if ("unref" in proc && typeof proc.unref === "function") proc.unref();
	} catch (err) {
		logger.warn({ src: "menus", err: err instanceof Error ? err.message : String(err) }, "[Menus] relaunch spawn failed");
	}
	Utils.quit();
}

function menuAction(event: unknown): string {
	if (!event || typeof event !== "object") return "";
	const data = (event as { data?: unknown }).data;
	if (!data || typeof data !== "object") return "";
	const action = (data as { action?: unknown }).action;
	return typeof action === "string" ? action : "";
}

export const menusFeature: Feature = {
	id: "menus",
	init(deps) {
		ApplicationMenu.setApplicationMenu([
			{
				label: "Detour",
				submenu: [
					{ role: "about" },
					{ type: "separator" },
					{ label: "Settings…", action: "app:settings", accelerator: GLOBAL_SHORTCUTS.openSettings },
					{ type: "separator" },
					{ label: WINDOW_TARGET_META.capsule.menuLabel, action: "capsule:open", accelerator: WINDOW_TARGET_META.capsule.accelerator },
					{ label: "Open Tray Dashboard", action: "tray:open" },
					{ type: "separator" },
					{ role: "hide" },
					{ role: "hideOthers" },
					{ role: "unhide" },
					{ type: "separator" },
					{ label: "Restart Detour", action: "app:restart", accelerator: "CommandOrControl+Shift+R" },
					{ role: "quit" },
				],
			},
			{
				label: "Edit",
				submenu: [
					{ role: "undo" },
					{ role: "redo" },
					{ type: "separator" },
					{ role: "cut" },
					{ role: "copy" },
					{ role: "paste" },
					{ role: "selectAll" },
				],
			},
			{
				label: "Detour Hub",
				submenu: [
					{ label: "Toggle Detour", action: "chat:toggle", accelerator: GLOBAL_SHORTCUTS.toggleChat },
					{ label: WINDOW_TARGET_META.capsule.menuLabel, action: "capsule:open", accelerator: WINDOW_TARGET_META.capsule.accelerator },
					{ label: WINDOW_TARGET_META.chat.menuLabel, action: "chat:open" },
					{ type: "separator" },
					{ label: WINDOW_TARGET_META.settings.menuLabel, action: "app:settings" },
				],
			},
			{
				label: "Pensieve",
				submenu: [
					{ label: WINDOW_TARGET_META.pensieve.menuLabel, action: "pensieve:open", accelerator: WINDOW_TARGET_META.pensieve.accelerator },
				],
			},
			{
				label: "Activity",
				submenu: [
					{ label: WINDOW_TARGET_META.activity.menuLabel, action: "activity:open", accelerator: WINDOW_TARGET_META.activity.accelerator },
				],
			},
			{
				label: "Browser",
				submenu: [
					{ label: WINDOW_TARGET_META.browser.menuLabel, action: "browser:open", accelerator: WINDOW_TARGET_META.browser.accelerator },
				],
			},
			{
				label: "Gallery",
				submenu: [
					{ label: WINDOW_TARGET_META.gallery.menuLabel, action: "gallery:open", accelerator: WINDOW_TARGET_META.gallery.accelerator },
				],
			},
			{
				label: "Window",
				submenu: [
					{ role: "minimize" },
					{ role: "close" },
				],
			},
		]);

		ApplicationMenu.on("application-menu-clicked", (event: unknown) => {
			const action = menuAction(event);
			switch (action) {
				case "app:settings":
					deps.events.emit("ui:open-settings", {});
					break;
				case "app:restart":
					relaunch();
					break;
				case "chat:toggle":
					deps.events.emit("ui:toggle-chat", {});
					break;
				case "chat:open":
					deps.events.emit("ui:open-chat", {});
					break;
				case "capsule:open":
					deps.events.emit("ui:open-capsule", {});
					break;
				case "tray:open":
					deps.events.emit("ui:open-tray-popover", {});
					break;
				case "pensieve:open":
					deps.events.emit("ui:open-pensieve", {});
					break;
				case "activity:open":
					deps.events.emit("ui:open-activity", {});
					break;
				case "browser:open":
					deps.events.emit("ui:open-browser", {});
					break;
				case "gallery:open":
					deps.events.emit("ui:open-gallery", {});
					break;
			}
		});
	},
};
