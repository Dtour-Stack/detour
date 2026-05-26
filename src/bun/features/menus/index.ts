import { ApplicationMenu, Utils } from "electrobun/bun";
import { logger } from "@elizaos/core";
import type { Feature } from "../../kernel/registry";

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
		(proc as unknown as { unref?: () => void }).unref?.();
	} catch (err) {
		logger.warn({ src: "menus", err: err instanceof Error ? err.message : String(err) }, "[Menus] relaunch spawn failed");
	}
	Utils.quit();
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
					{ label: "Settings…", action: "app:settings", accelerator: "CommandOrControl+Shift+S" },
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
					{ label: "Toggle Detour", action: "chat:toggle", accelerator: "CommandOrControl+Shift+Space" },
					{ label: "Open Detour", action: "chat:open" },
					{ type: "separator" },
					{ label: "Open Configuration", action: "app:settings" },
				],
			},
			{
				label: "Pensieve",
				submenu: [
					{ label: "Open Pensieve", action: "pensieve:open", accelerator: "CommandOrControl+Shift+P" },
				],
			},
			{
				label: "Activity",
				submenu: [
					{ label: "Open Activity", action: "activity:open", accelerator: "CommandOrControl+Shift+A" },
				],
			},
			{
				label: "Browser",
				submenu: [
					{ label: "Open Browser", action: "browser:open", accelerator: "CommandOrControl+Shift+B" },
				],
			},
			{
				label: "Gallery",
				submenu: [
					{ label: "Open Gallery", action: "gallery:open", accelerator: "CommandOrControl+Shift+G" },
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

		ApplicationMenu.on("application-menu-clicked", (event: any) => {
			const action: string = event?.data?.action ?? "";
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
