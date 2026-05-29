import type { Feature } from "../../kernel/registry";
import { broadcaster } from "../../core/rpc/registry";
import { WINDOW_TARGET_META } from "../../../shared/window-targets";

/**
 * Pensieve = memories / relationships / templates / graph browser.
 *
 * Lives as a tab inside the Detour hub (chat window), not a separate window.
 * Opening it just shows the hub and broadcasts `uiOpenPensieve`, which the
 * React app turns into `setActiveView("pensieve")` (see App.tsx). The
 * `forwarded` guard stops the kernel's broadcast→event bridge from looping
 * back into `open()`. Mirrors the browser feature.
 */
export const pensieveFeature: Feature = {
	id: "pensieve",
	init(deps) {
		let forwarded = false;

		function open() {
			deps.events.emit("ui:open-chat", {});
			const route = () => {
				forwarded = true;
				broadcaster.broadcast("uiOpenPensieve", {});
				setTimeout(() => { forwarded = false; }, 0);
			};
			// Retry a few times so the hub webview has time to mount + wire
			// its RPC listener before we deliver the tab-switch.
			setTimeout(route, 150);
			setTimeout(route, 400);
			setTimeout(route, 900);
		}

		deps.tray.addMenuItem(
			{ label: WINDOW_TARGET_META.pensieve.menuLabel, action: "pensieve:open", order: 30 },
			() => open(),
		);
		deps.events.on("ui:open-pensieve", () => {
			if (forwarded) return;
			open();
		});
	},
};
