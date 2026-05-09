import type { Feature } from "../../kernel/registry";
import type { WindowHandle } from "../../kernel/windows";

const DEFAULT_WIDTH = 1200;
const DEFAULT_HEIGHT = 800;
import { resolveViewUrl } from "../../kernel/view-url";

/**
 * Pensieve = activity / memories / relationships / graph browser.
 * Lives in its own regular window (titled, resizable, centered) — chat
 * popup is too cramped for the graph + side-panel layout.
 *
 * Loaded from the same Vite bundle as the chat popup; the React app reads
 * `window.location.hash === "#pensieve"` and mounts <PensieveView/> instead
 * of <App/>.
 */
export const pensieveFeature: Feature = {
	id: "pensieve",
	init(deps) {
		let pensieveWindow: WindowHandle | null = null;

		function open() {
			if (pensieveWindow) {
				try {
					(pensieveWindow.window as unknown as { activate?: () => void }).activate?.();
				} catch {
					// best effort
				}
				pensieveWindow.show();
				return;
			}
			const handle = deps.windows.createWindow({
				viewKey: "pensieve", // unused (overridden by url) but required by the type
				title: "Detour Pensieve",
				width: DEFAULT_WIDTH,
				height: DEFAULT_HEIGHT,
				centered: true,
				url: resolveViewUrl("pensieve"),
			});
			handle.onClose(() => {
				pensieveWindow = null;
			});
			pensieveWindow = handle;
		}

		deps.tray.addMenuItem(
			{ label: "Open Pensieve", action: "pensieve:open", order: 30 },
			() => open(),
		);
		deps.events.on("ui:open-pensieve", () => open());
	},
};
