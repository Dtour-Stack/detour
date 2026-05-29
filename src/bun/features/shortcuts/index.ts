import { GlobalShortcut } from "electrobun/bun";
import { logger } from "@elizaos/core";
import type { Feature } from "../../kernel/registry";
import { GLOBAL_SHORTCUTS, WINDOW_TARGET_META } from "../../../shared/window-targets";

function registerShortcut(accelerator: string, label: string, handler: () => void): void {
	const ok = GlobalShortcut.register(accelerator, handler);
	if (!ok) {
		logger.warn({ src: "shortcuts", accelerator }, "[Shortcuts] register failed");
		return;
	}
	logger.info({ src: "shortcuts", accelerator, label }, "[Shortcuts] registered");
}

export const shortcutsFeature: Feature = {
	id: "shortcuts",
	init(deps) {
		registerShortcut(GLOBAL_SHORTCUTS.toggleChat, "toggle chat", () => {
			deps.events.emit("ui:toggle-chat", {});
		});

		registerShortcut(GLOBAL_SHORTCUTS.openCapsule, WINDOW_TARGET_META.capsule.label, () => {
			deps.events.emit("ui:open-capsule", {});
		});

		registerShortcut(GLOBAL_SHORTCUTS.openSettings, WINDOW_TARGET_META.settings.label, () => {
			deps.events.emit("ui:open-settings", {});
		});

		registerShortcut(GLOBAL_SHORTCUTS.openPensieve, WINDOW_TARGET_META.pensieve.label, () => {
			deps.events.emit("ui:open-pensieve", {});
		});

		registerShortcut(GLOBAL_SHORTCUTS.openActivity, WINDOW_TARGET_META.activity.label, () => {
			deps.events.emit("ui:open-activity", {});
		});

		registerShortcut(GLOBAL_SHORTCUTS.openBrowser, WINDOW_TARGET_META.browser.label, () => {
			deps.events.emit("ui:open-browser", {});
		});
	},
};
