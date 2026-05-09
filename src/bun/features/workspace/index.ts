import type { Feature } from "../../kernel/registry";
import type { WindowHandle } from "../../kernel/windows";
import { resolveViewUrl } from "../../kernel/view-url";

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 820;

/**
 * Workspace window — agentic IDE shell. Opens as its own BrowserWindow
 * (renderer="native") and reuses the shared RPC handler bag, so all
 * agentProject* RPCs work without a feature-local schema. Singleton:
 * re-opening focuses the existing window instead of stacking copies.
 */
export const workspaceFeature: Feature = {
	id: "workspace",
	init(deps) {
		let win: WindowHandle | null = null;

		function open() {
			if (win) {
				try { (win.window as unknown as { activate?: () => void }).activate?.(); } catch { /* ignore */ }
				win.show();
				return;
			}
			const handle = deps.windows.createWindow({
				viewKey: "workspace",
				title: "Detour Workspace",
				width: DEFAULT_WIDTH,
				height: DEFAULT_HEIGHT,
				centered: true,
				url: resolveViewUrl("workspace"),
			});
			handle.onClose(() => { win = null; });
			win = handle;
		}

		deps.tray.addMenuItem(
			{ label: "Open Workspace", action: "workspace:open", order: 26 },
			() => open(),
		);
		deps.events.on("ui:open-workspace", () => open());
	},
};
