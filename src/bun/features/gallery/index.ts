import { resolveViewUrl } from "../../kernel/view-url";
import type { Feature } from "../../kernel/registry";
import type { WindowHandle } from "../../kernel/windows";

const DEFAULT_WIDTH = 1180;
const DEFAULT_HEIGHT = 780;

export const galleryFeature: Feature = {
	id: "gallery",
	init(deps) {
		let win: WindowHandle | null = null;

		function open() {
			if (win) {
				try { (win.window as { activate?: () => void }).activate?.(); } catch { /* ignore */ }
				win.show();
				return;
			}
			const handle = deps.windows.createWindow({
				viewKey: "gallery",
				title: "Detour Gallery",
				width: DEFAULT_WIDTH,
				height: DEFAULT_HEIGHT,
				centered: true,
				url: resolveViewUrl("gallery"),
			});
			handle.onClose(() => { win = null; });
			win = handle;
		}

		deps.tray.addMenuItem(
			{ label: "Open Gallery", action: "gallery:open", order: 27 },
			() => open(),
		);
		deps.events.on("ui:open-gallery", () => open());
	},
};
