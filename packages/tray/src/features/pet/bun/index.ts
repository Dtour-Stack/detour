import { resolveViewUrl } from "../../../bun/kernel/view-url";
import type { Feature } from "../../../bun/kernel/registry";
import type { WindowHandle } from "../../../bun/kernel/windows";

const WIDTH = 380;
const HEIGHT = 320;

export const petFeature: Feature = {
	id: "pet",
	init(deps) {
		let petWindow: WindowHandle | null = null;
		let movedByUser = false;

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
				movedByUser = false;
			});
			petWindow = handle;
			return handle;
		}

		function open() {
			const handle = ensureWindow();
			if (!movedByUser) {
				deps.windows.positionUnderTrayBounds(handle, deps.tray.getBounds(), WIDTH, HEIGHT, 16);
			}
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
		deps.events.on("ui:pet-window-drag", ({ dx, dy }) => {
			if (!petWindow) return;
			movedByUser = true;
			const position = petWindow.window.getPosition();
			petWindow.window.setPosition(
				Math.round(position.x + dx),
				Math.round(position.y + dy),
			);
		});
	},
};
