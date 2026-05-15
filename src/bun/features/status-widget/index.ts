/**
 * Floating status widget — small always-on-top overlay window. Off by
 * default; user toggles via Settings → Tray → "Show status widget".
 *
 * Window: 240×56, frameless + transparent (matches the pet pattern).
 * Auto-positions just below the menu bar tray icon on first show; the
 * user can drag it anywhere afterward and the position persists.
 *
 * Reuses the pet drag RPC (`petWindowDrag`) — the bun-side drag
 * handler is keyed to whichever window currently owns it, so we just
 * register on show + unregister on hide.
 */

import { resolveViewUrl } from "../../kernel/view-url";
import type { Feature } from "../../kernel/registry";
import type { WindowHandle } from "../../kernel/windows";
import { setPetWindowDragHandler } from "../../core/rpc/handlers/pets";
import { onTrayPrefsChangedBunSide } from "../../core/rpc/handlers/config";

const WIDTH = 240;
const HEIGHT = 56;

export const statusWidgetFeature: Feature = {
	id: "status-widget",
	init(deps) {
		let widget: WindowHandle | null = null;
		let movedByUser = false;

		function ensure(): WindowHandle {
			if (widget) return widget;
			const handle = deps.windows.createPopup({
				viewKey: "status-widget",
				width: WIDTH,
				height: HEIGHT,
				url: resolveViewUrl("status-widget"),
				hideOnBlur: false,
				alwaysOnTop: true,
				transparent: true,
			});
			handle.onClose(() => {
				widget = null;
				movedByUser = false;
			});
			widget = handle;
			return handle;
		}

		function show() {
			const handle = ensure();
			setPetWindowDragHandler(({ dx, dy }) => {
				if (!widget) return;
				movedByUser = true;
				const win = widget.window as unknown as {
					getPosition: () => { x: number; y: number };
					setPosition: (x: number, y: number) => void;
				};
				try {
					const pos = win.getPosition();
					win.setPosition(Math.round(pos.x + dx), Math.round(pos.y + dy));
				} catch {
					/* best-effort */
				}
			});
			if (!movedByUser) {
				deps.windows.positionBelowTrayBounds(
					handle,
					deps.tray.getBounds(),
					WIDTH,
					HEIGHT,
					8,
				);
			}
			handle.show();
		}

		function hide() {
			if (!widget) return;
			widget.hide();
			setPetWindowDragHandler(null);
		}

		async function applyPref(enabled: boolean) {
			if (enabled) show();
			else hide();
		}

		// Initial state on boot — read user pref.
		void deps.core.rpcDeps.config
			.getTrayPrefs()
			.then((prefs) => void applyPref(prefs.statusWidgetEnabled))
			.catch(() => {
				/* default off */
			});

		// React to settings flips without restart.
		onTrayPrefsChangedBunSide((prefs) => void applyPref(prefs.statusWidgetEnabled));
	},
};
