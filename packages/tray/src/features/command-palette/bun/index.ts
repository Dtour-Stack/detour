import { resolveViewUrl } from "../../../bun/kernel/view-url";
import type { Feature } from "../../../bun/kernel/registry";
import type { WindowHandle } from "../../../bun/kernel/windows";

const WIDTH = 720;
const HEIGHT = 620;

export const commandPaletteFeature: Feature = {
	id: "command-palette",
	init(deps) {
		let window: WindowHandle | null = null;
		let shown = false;

		function ensureWindow(): WindowHandle {
			if (window) return window;
			const handle = deps.windows.createPopup({
				viewKey: "command-palette",
				width: WIDTH,
				height: HEIGHT,
				url: resolveViewUrl("command-palette"),
				hideOnBlur: true,
				alwaysOnTop: true,
				rpc: {
					maxRequestTime: 60_000,
					handlers: { requests: {}, messages: {} },
				},
			});
			handle.onClose(() => {
				window = null;
				shown = false;
			});
			handle.onBlur(() => hide());
			window = handle;
			return handle;
		}

		function show() {
			const handle = ensureWindow();
			deps.windows.positionCentered(handle, WIDTH, HEIGHT);
			handle.show();
			handle.focus();
			shown = true;
		}

		function hide() {
			if (!window || !shown) return;
			window.hide();
			shown = false;
		}

		function toggle() {
			if (shown) hide();
			else show();
		}

		deps.events.on("ui:open-command-palette", () => show());
		deps.events.on("ui:toggle-command-palette", () => toggle());
		deps.events.on("ui:close-command-palette", () => hide());
	},
};
