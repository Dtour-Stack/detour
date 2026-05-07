import { resolveViewUrl } from "../../../bun/kernel/view-url";
import type { Feature } from "../../../bun/kernel/registry";
import type { WindowHandle } from "../../../bun/kernel/windows";

const DEFAULT_WIDTH = 1240;
const DEFAULT_HEIGHT = 820;

export const agentsFeature: Feature = {
	id: "agents",
	init(deps) {
		let agentsWindow: WindowHandle | null = null;

		function open() {
			if (agentsWindow) {
				(agentsWindow.window as unknown as { activate?: () => void }).activate?.();
				agentsWindow.show();
				return;
			}
			const handle = deps.windows.createWindow({
				viewKey: "agents",
				title: "Detour Agents",
				width: DEFAULT_WIDTH,
				height: DEFAULT_HEIGHT,
				centered: true,
				url: resolveViewUrl("agents"),
				rpc: {
					maxRequestTime: 60_000,
					handlers: { requests: {}, messages: {} },
				},
			});
			handle.onClose(() => {
				agentsWindow = null;
			});
			agentsWindow = handle;
		}

		deps.tray.addMenuItem(
			{ label: "Open Agents", action: "agents:open", order: 28 },
			() => open(),
		);
		deps.events.on("ui:open-agents", () => open());
	},
};
