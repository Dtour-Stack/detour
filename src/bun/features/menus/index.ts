import { ApplicationMenu } from "electrobun/bun";
import type { Feature } from "../../kernel/registry";

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
				label: "Chat",
				submenu: [
					{ label: "Toggle Chat", action: "chat:toggle", accelerator: "CommandOrControl+Shift+Space" },
					{ label: "Open Chat", action: "chat:open" },
					{ type: "separator" },
					{ label: "Open Settings", action: "app:settings" },
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
				label: "Channels",
				submenu: [
					{ label: "Open Channels", action: "channels:open", accelerator: "CommandOrControl+Shift+C" },
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
				case "channels:open":
					deps.events.emit("ui:open-channels", {});
					break;
			}
		});
	},
};
