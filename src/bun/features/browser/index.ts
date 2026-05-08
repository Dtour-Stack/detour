import type { Feature } from "../../kernel/registry";
import type { WindowHandle } from "../../kernel/windows";
import { resolveViewUrl } from "../../kernel/view-url";

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 860;

export const browserFeature: Feature = {
	id: "browser",
	init(deps) {
		let browserWindow: WindowHandle | null = null;

		function open() {
			if (browserWindow) {
				try {
					(browserWindow.window as unknown as { activate?: () => void }).activate?.();
				} catch {
					// best effort
				}
				browserWindow.show();
				return;
			}
			const handle = deps.windows.createWindow({
				viewKey: "browser",
				title: "Detour Browser",
				width: DEFAULT_WIDTH,
				height: DEFAULT_HEIGHT,
				centered: true,
				url: resolveViewUrl("browser"),
				rpc: {
					maxRequestTime: 60_000,
					handlers: { requests: {}, messages: {} },
				},
			});
			handle.onClose(() => {
				browserWindow = null;
			});
			browserWindow = handle;
		}

		deps.tray.addMenuItem(
			{ label: "Open Browser", action: "browser:open", order: 28 },
			() => open(),
		);
		deps.events.on("ui:open-browser", () => open());
	},
};
