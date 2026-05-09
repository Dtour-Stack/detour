import type { Feature } from "../../kernel/registry";
import type { WindowHandle } from "../../kernel/windows";

const DEFAULT_WIDTH = 1100;
const DEFAULT_HEIGHT = 750;
import { resolveViewUrl } from "../../kernel/view-url";

/**
 * Activity = trajectories + logs + runtime introspection. Operational view
 * separate from Pensieve (which is for user-facing memory/relationship data).
 */
export const activityFeature: Feature = {
	id: "activity",
	init(deps) {
		let w: WindowHandle | null = null;

		function open() {
			if (w) {
				try {
					(w.window as unknown as { activate?: () => void }).activate?.();
				} catch {
					// best effort
				}
				w.show();
				return;
			}
			const handle = deps.windows.createWindow({
				viewKey: "activity",
				title: "Detour Activity",
				width: DEFAULT_WIDTH,
				height: DEFAULT_HEIGHT,
				centered: true,
				url: resolveViewUrl("activity"),
			});
			handle.onClose(() => { w = null; });
			w = handle;
		}

		deps.tray.addMenuItem(
			{ label: "Open Activity", action: "activity:open", order: 25 },
			() => open(),
		);
		deps.events.on("ui:open-activity", () => open());
	},
};
