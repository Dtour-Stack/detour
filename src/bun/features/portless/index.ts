import type { Feature } from "../../kernel/registry";
import type { WindowHandle } from "../../kernel/windows";
import { resolveViewUrl } from "../../kernel/view-url";

const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 560;

/**
 * Portless = local-dev reverse proxy management. Browse registered
 * `<name>.localhost` routes, register new ones, prune stale entries.
 */
export const portlessFeature: Feature = {
	id: "portless",
	init(deps) {
		let w: WindowHandle | null = null;

		function open() {
			if (w) {
				try { (w.window as unknown as { activate?: () => void }).activate?.(); } catch {}
				w.show();
				return;
			}
			const handle = deps.windows.createWindow({
				viewKey: "portless",
				title: "Detour Portless",
				width: DEFAULT_WIDTH,
				height: DEFAULT_HEIGHT,
				centered: true,
				url: resolveViewUrl("portless"),
				rpc: {
					maxRequestTime: 30_000,
					handlers: { requests: {}, messages: {} },
				},
			});
			handle.onClose(() => { w = null; });
			w = handle;
		}

		deps.tray.addMenuItem(
			{ label: "Open Portless", action: "portless:open", order: 28 },
			() => open(),
		);
		deps.events.on("ui:open-portless", () => open());
	},
};
