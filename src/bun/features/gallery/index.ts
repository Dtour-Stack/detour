import type { Feature } from "../../kernel/registry";
import { broadcaster } from "../../core/rpc/registry";
import { WINDOW_TARGET_META } from "../../../shared/window-targets";

/**
 * Gallery = generated pictures / videos / audio.
 *
 * Lives as a tab inside the Detour hub (chat window), not a separate window.
 * Opening it shows the hub and broadcasts `uiOpenGallery`, which the React
 * app turns into `setActiveView("gallery")` (see App.tsx). The `forwarded`
 * guard stops the kernel's broadcast→event bridge from looping back into
 * `open()`. Mirrors the browser feature.
 *
 * (Previously this also spawned a standalone window, so a single broadcast
 * opened a window AND switched the hub tab — the duplicate surface is gone.)
 */
export const galleryFeature: Feature = {
	id: "gallery",
	init(deps) {
		let forwarded = false;

		function open() {
			deps.events.emit("ui:open-chat", {});
			const route = () => {
				forwarded = true;
				broadcaster.broadcast("uiOpenGallery", {});
				setTimeout(() => { forwarded = false; }, 0);
			};
			setTimeout(route, 150);
			setTimeout(route, 400);
			setTimeout(route, 900);
		}

		deps.tray.addMenuItem(
			{ label: WINDOW_TARGET_META.gallery.menuLabel, action: "gallery:open", order: 27 },
			() => open(),
		);
		deps.events.on("ui:open-gallery", () => {
			if (forwarded) return;
			open();
		});
	},
};
