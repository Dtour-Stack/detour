/**
 * Tray popover feature — owns the rich BrowserWindow that drops down
 * under the menu-bar tray icon.
 *
 * The native tray menu is still kept as a fallback (right-click on
 * macOS). The tray icon itself opens the capsule; this popover stays
 * available from the tray menu and app menu as a drill-down dashboard.
 */

import { Screen } from "electrobun/bun";
import { resolveViewUrl } from "../../kernel/view-url";
import type { Feature } from "../../kernel/registry";
import type { WindowHandle } from "../../kernel/windows";
import { setTrayPopoverDragHandler, setTrayPopoverHideHandler } from "../../core/rpc/handlers/tray-popover";
import { WINDOW_TARGET_META } from "../../../shared/window-targets";

const POPOVER_WIDTH = 320;
const POPOVER_HEIGHT = 480;

export const trayPopoverFeature: Feature = {
	id: "tray-popover",
	init(deps) {
		let popover: WindowHandle | null = null;
		let isShown = false;
		/** Once the user drags, we stop auto-positioning under the tray icon. */
		let movedByUser = false;
		let position: { x: number; y: number } | null = null;

		function ensure(): WindowHandle {
			if (popover) return popover;
			const handle = deps.windows.createPopup({
				viewKey: "tray-popover",
				width: POPOVER_WIDTH,
				height: POPOVER_HEIGHT,
				hideOnBlur: true,
				alwaysOnTop: true,
				transparent: true,
				url: resolveViewUrl("tray-popover"),
			});
			handle.onClose(() => {
				popover = null;
				isShown = false;
				movedByUser = false;
				position = null;
				setTrayPopoverDragHandler(null);
				setTrayPopoverHideHandler(null);
			});
			// Auto-hide when focus leaves the popover. Mirrors the native
			// macOS menu-bar dropdown behavior — click outside → close.
			handle.onBlur(() => {
				if (!isShown) return;
				handle.hide();
				isShown = false;
			});
			setTrayPopoverDragHandler(({ dx, dy }) => {
				if (!popover || !position) return;
				movedByUser = true;
				position = {
					x: Math.round(position.x + dx),
					y: Math.round(position.y + dy),
				};
				popover.window.setPosition(position.x, position.y);
			});
			setTrayPopoverHideHandler(() => {
				if (!popover || !isShown) return;
				popover.hide();
				isShown = false;
			});
			popover = handle;
			return handle;
		}

		function show() {
			const handle = ensure();
			if (!movedByUser) {
				const bounds = deps.tray.getBounds();
				// Position before show so the window doesn't flash at (0, 0).
				deps.windows.positionBelowTrayBounds(
					handle,
					bounds,
					POPOVER_WIDTH,
					POPOVER_HEIGHT,
				);
				// Snapshot the position so dragging starts from the right place.
				// positionBelowTrayBounds clamps to screen, replicate the same math:
				const display = Screen.getPrimaryDisplay();
				const gap = 4;
				const rawX = Math.round(bounds.x + bounds.width / 2 - POPOVER_WIDTH / 2);
				const rawY = Math.round(bounds.y + bounds.height + gap);
				position = {
					x: Math.max(gap, Math.min(rawX, display.bounds.width - POPOVER_WIDTH - gap)),
					y: Math.max(gap, Math.min(rawY, display.bounds.height - POPOVER_HEIGHT - gap)),
				};
			}
			handle.show();
			handle.focus();
			isShown = true;
		}

		function hide() {
			if (!popover || !isShown) return;
			popover.hide();
			isShown = false;
		}

		function toggle() {
			if (isShown) hide();
			else show();
		}

		deps.tray.addMenuItem(
			{ label: WINDOW_TARGET_META.capsule.menuLabel, action: "tray-popover:open", order: 10 },
			() => toggle(),
		);
		deps.events.on("ui:open-tray-popover", () => show());
		deps.tray.onIconClicked(() => deps.events.emit("ui:open-capsule", {}));
	},
};
