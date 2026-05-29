import type { Feature } from "../../kernel/registry";
import { broadcaster } from "../../core/rpc/registry";

/**
 * Portless = local-dev reverse proxy management.
 *
 * Lives as a tab inside the Detour hub (chat window), not a separate window.
 * Opening it shows the hub and broadcasts `uiOpenPortless`, which the React
 * app turns into `setActiveView("portless")` (see App.tsx). The `forwarded`
 * guard stops the kernel's broadcast→event bridge from looping back into
 * `open()`. Mirrors the browser feature.
 */
export const portlessFeature: Feature = {
	id: "portless",
	init(deps) {
		let forwarded = false;

		function open() {
			deps.events.emit("ui:open-chat", {});
			const route = () => {
				forwarded = true;
				broadcaster.broadcast("uiOpenPortless", {});
				setTimeout(() => { forwarded = false; }, 0);
			};
			setTimeout(route, 150);
			setTimeout(route, 400);
			setTimeout(route, 900);
		}

		deps.tray.addMenuItem(
			{ label: "Open Portless", action: "portless:open", order: 28 },
			() => open(),
		);
		deps.events.on("ui:open-portless", () => {
			if (forwarded) return;
			open();
		});
	},
};
