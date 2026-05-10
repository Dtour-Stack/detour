import { resolveViewUrl } from "../../kernel/view-url";
import type { Feature } from "../../kernel/registry";
import type { WindowHandle } from "../../kernel/windows";
import { setPetWindowDragHandler } from "../../core/rpc/handlers/pets";

// Small floating sprite window. Frameless + transparent so the pet
// renders directly on the desktop. Stays on top so it doesn't get
// hidden behind the chat or settings windows. Drag is driven by the
// view (PetWindow.tsx) via rpc.send.petWindowDrag — the registered
// drag handler below translates deltas to BrowserWindow.setPosition.
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
			});
			handle.onClose(() => {
				petWindow = null;
				movedByUser = false;
				setPetWindowDragHandler(null);
			});
			setPetWindowDragHandler(({ dx, dy }) => {
				if (!petWindow) return;
				movedByUser = true;
				const win = petWindow.window as unknown as {
					getPosition: () => { x: number; y: number };
					setPosition: (x: number, y: number) => void;
				};
				try {
					const pos = win.getPosition();
					win.setPosition(Math.round(pos.x + dx), Math.round(pos.y + dy));
				} catch {
					// best-effort; some platforms / electrobun versions may
					// not surface get/setPosition on the popup window.
				}
			});
			petWindow = handle;
			return handle;
		}

		function open() {
			const handle = ensureWindow();
			if (!movedByUser) {
				deps.windows.positionUnderTrayBounds(
					handle,
					deps.tray.getBounds(),
					WIDTH,
					HEIGHT,
					16,
				);
			}
			handle.show();
		}

		deps.tray.addMenuItem(
			{ label: "Spawn Pet", action: "pet:open", order: 32 },
			() => open(),
		);
		deps.events.on("ui:open-pet", () => open());
	},
};
