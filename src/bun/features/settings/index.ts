import type { Feature } from "../../kernel/registry";

/**
 * Settings used to be a separate window; now it lives as a drawer inside the
 * chat window. This feature is just the menu/keybind plumbing — it tells the
 * chat feature to open the chat window AND publishes a `ui:open-settings`
 * message so the React app opens its drawer.
 */
export const settingsFeature: Feature = {
	id: "settings",
	init(deps) {
		deps.tray.addMenuItem(
			{ label: "Settings", action: "settings:open", order: 20 },
			() => deps.events.emit("ui:open-settings", {}),
		);
	},
};
