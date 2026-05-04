import { GlobalShortcut } from "electrobun/bun";
import type { Feature } from "../../../bun/kernel/registry";

const TOGGLE_CHAT = "CommandOrControl+Shift+Space";
const OPEN_SETTINGS = "CommandOrControl+Shift+S";

export const shortcutsFeature: Feature = {
	id: "shortcuts",
	init(deps) {
		const okChat = GlobalShortcut.register(TOGGLE_CHAT, () => {
			deps.events.emit("ui:toggle-chat", {});
		});
		if (!okChat) {
			console.warn(`[shortcuts] failed to register ${TOGGLE_CHAT} (likely in use)`);
		} else {
			console.log(`[shortcuts] ${TOGGLE_CHAT} → toggle chat`);
		}

		const okSettings = GlobalShortcut.register(OPEN_SETTINGS, () => {
			deps.events.emit("ui:open-settings", {});
		});
		if (!okSettings) {
			console.warn(`[shortcuts] failed to register ${OPEN_SETTINGS}`);
		} else {
			console.log(`[shortcuts] ${OPEN_SETTINGS} → open settings`);
		}
	},
};
