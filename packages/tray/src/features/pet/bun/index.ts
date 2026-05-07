import { resolveViewUrl } from "../../../bun/kernel/view-url";
import type { Feature } from "../../../bun/kernel/registry";
import type { WindowHandle } from "../../../bun/kernel/windows";

const WIDTH = 224;
const HEIGHT = 244;

export const petFeature: Feature = {
	id: "pet",
	init(deps) {
		let petWindow: WindowHandle | null = null;

		function ensureWindow(): WindowHandle {
			if (petWindow) return petWindow;
			const handle = deps.windows.createPopup({
				viewKey: "pet",
				width: WIDTH,
				height: HEIGHT,
				url: resolveViewUrl("pet"),
				hideOnBlur: false,
				alwaysOnTop: true,
				transparent: true,
				rpc: {
					maxRequestTime: 60_000,
					handlers: { requests: {}, messages: {} },
				},
			});
			handle.onClose(() => {
				petWindow = null;
			});
			petWindow = handle;
			return handle;
		}

		function open() {
			const handle = ensureWindow();
			deps.windows.positionUnderTrayBounds(handle, deps.tray.getBounds(), WIDTH, HEIGHT, 16);
			handle.show();
		}

		deps.tray.addMenuItem(
			{ label: "Spawn Pet", action: "pet:open", order: 32 },
			() => {
				void fetch(`http://127.0.0.1:${deps.core.port}/api/pets/spawn`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({}),
				}).catch(() => open());
			},
		);
		deps.events.on("ui:open-pet", () => open());
	},
};
