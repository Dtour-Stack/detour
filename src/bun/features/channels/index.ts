import type { Feature } from "../../kernel/registry";
import type { WindowHandle } from "../../kernel/windows";

const DEFAULT_WIDTH = 1100;
const DEFAULT_HEIGHT = 760;
import { resolveViewUrl } from "../../kernel/view-url";

/**
 * Channels window — Discord / Telegram / iMessage connector status, credentials,
 * and (eventually) per-channel conversation surfaces. Loads the same Vite
 * bundle hash-routed via `#channels`.
 */
export const channelsFeature: Feature = {
	id: "channels",
	init(deps) {
		let channelsWindow: WindowHandle | null = null;

		function open() {
			if (channelsWindow) {
				try {
					(channelsWindow.window as unknown as { activate?: () => void }).activate?.();
				} catch {
					// best effort
				}
				channelsWindow.show();
				return;
			}
			const handle = deps.windows.createWindow({
				viewKey: "channels",
				title: "Detour Channels",
				width: DEFAULT_WIDTH,
				height: DEFAULT_HEIGHT,
				centered: true,
				url: resolveViewUrl("channels"),
			});
			handle.onClose(() => {
				channelsWindow = null;
			});
			channelsWindow = handle;
		}

		deps.tray.addMenuItem(
			{ label: "Open Channels", action: "channels:open", order: 35 },
			() => open(),
		);
		deps.events.on("ui:open-channels", () => open());
	},
};
