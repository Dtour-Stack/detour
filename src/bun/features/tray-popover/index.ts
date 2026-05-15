/**
 * Tray popover feature — owns the rich BrowserWindow that drops down
 * under the menu-bar tray icon. Replaces the old "tray icon click →
 * toggle chat" behavior; the popover is now the primary surface.
 *
 * The native tray menu is still kept as a fallback (right-click on
 * macOS), pruned down to just a Quit item — the popover handles
 * everything else.
 */

import { resolveViewUrl } from "../../kernel/view-url";
import type { Feature } from "../../kernel/registry";
import type { WindowHandle } from "../../kernel/windows";

const POPOVER_WIDTH = 320;
const POPOVER_HEIGHT = 480;

export const trayPopoverFeature: Feature = {
	id: "tray-popover",
	init(deps) {
		let popover: WindowHandle | null = null;
		let isShown = false;

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
			});
			// Auto-hide when focus leaves the popover. Mirrors the native
			// macOS menu-bar dropdown behavior — click outside → close.
			handle.onBlur(() => {
				if (!isShown) return;
				handle.hide();
				isShown = false;
			});
			popover = handle;
			return handle;
		}

		function show() {
			const handle = ensure();
			const bounds = deps.tray.getBounds();
			// Position before show so the window doesn't flash at (0, 0).
			deps.windows.positionBelowTrayBounds(
				handle,
				bounds,
				POPOVER_WIDTH,
				POPOVER_HEIGHT,
			);
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

		// Wire tray-icon click → toggle popover. NOTE: the chat feature
		// also registers an onIconClicked handler; if both run, both
		// handlers fire on a single click. The chat feature still owns
		// the global Cmd+Shift+C shortcut and its menu item, so we strip
		// its tray-icon binding by adding the popover handler — the
		// popover is the canonical click target now.
		deps.tray.onIconClicked(() => toggle());
	},
};
