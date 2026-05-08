import { GlobalShortcut } from "electrobun/bun";
import type { Feature } from "../../kernel/registry";

const TOGGLE_CHAT = "CommandOrControl+Shift+Space";
const OPEN_SETTINGS = "CommandOrControl+Shift+S";
const OPEN_PENSIEVE = "CommandOrControl+Shift+P";
const OPEN_ACTIVITY = "CommandOrControl+Shift+A";
const OPEN_BROWSER = "CommandOrControl+Shift+B";

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

		const okPensieve = GlobalShortcut.register(OPEN_PENSIEVE, () => {
			deps.events.emit("ui:open-pensieve", {});
		});
		if (!okPensieve) {
			console.warn(`[shortcuts] failed to register ${OPEN_PENSIEVE}`);
		} else {
			console.log(`[shortcuts] ${OPEN_PENSIEVE} → open pensieve`);
		}

		const okActivity = GlobalShortcut.register(OPEN_ACTIVITY, () => {
			deps.events.emit("ui:open-activity", {});
		});
		if (!okActivity) {
			console.warn(`[shortcuts] failed to register ${OPEN_ACTIVITY}`);
		} else {
			console.log(`[shortcuts] ${OPEN_ACTIVITY} → open activity`);
		}

		const okBrowser = GlobalShortcut.register(OPEN_BROWSER, () => {
			deps.events.emit("ui:open-browser", {});
		});
		if (!okBrowser) {
			console.warn(`[shortcuts] failed to register ${OPEN_BROWSER}`);
		} else {
			console.log(`[shortcuts] ${OPEN_BROWSER} → open browser`);
		}
	},
};
