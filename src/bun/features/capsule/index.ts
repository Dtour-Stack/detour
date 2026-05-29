import { Screen } from "electrobun/bun";
import { resolveViewUrl } from "../../kernel/view-url";
import type { Feature } from "../../kernel/registry";
import type { WindowHandle } from "../../kernel/windows";
import { setCapsuleWindowDragHandler, setCapsuleWindowHideHandler } from "../../core/rpc/handlers/capsule";
import { WINDOW_TARGET_META } from "../../../shared/window-targets";

const WIDTH = 620;
const HEIGHT = 280;

export const capsuleFeature: Feature = {
	id: "capsule",
	init(deps) {
		let capsule: WindowHandle | null = null;
		let movedByUser = false;
		let position: { x: number; y: number } | null = null;

		function positionDefault(handle: WindowHandle): void {
			const display = Screen.getPrimaryDisplay();
			const x = Math.round(display.bounds.x + (display.bounds.width - WIDTH) / 2);
			const y = Math.round(display.bounds.y + 86);
			position = { x, y };
			handle.window.setPosition(x, y);
		}

		function ensure(): WindowHandle {
			if (capsule) return capsule;
			const handle = deps.windows.createPopup({
				viewKey: "capsule",
				width: WIDTH,
				height: HEIGHT,
				url: resolveViewUrl("capsule"),
				hideOnBlur: false,
				alwaysOnTop: true,
				transparent: true,
			});
			handle.onClose(() => {
				capsule = null;
				movedByUser = false;
				position = null;
				setCapsuleWindowDragHandler(null);
				setCapsuleWindowHideHandler(null);
			});
			setCapsuleWindowHideHandler(() => {
				if (!capsule) return;
				capsule.hide();
			});
			setCapsuleWindowDragHandler(({ dx, dy }) => {
				if (!capsule || !position) return;
				movedByUser = true;
				position = {
					x: Math.round(position.x + dx),
					y: Math.round(position.y + dy),
				};
				capsule.window.setPosition(position.x, position.y);
			});
			capsule = handle;
			return handle;
		}

		function open() {
			const handle = ensure();
			if (!movedByUser) positionDefault(handle);
			handle.show();
			handle.focus();
		}

		deps.tray.addMenuItem(
			{ label: WINDOW_TARGET_META.capsule.menuLabel, action: "capsule:open", order: 9 },
			() => open(),
		);
		deps.events.on("ui:open-capsule", () => open());
	},
};
