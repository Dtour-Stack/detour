import type { Feature } from "../../kernel/registry";
import { broadcaster } from "../../core/rpc/registry";
import { WINDOW_TARGET_META } from "../../../shared/window-targets";

/**
 * Activity = trajectories + logs + runtime introspection + subagents + tasks.
 *
 * Lives as a tab inside the Detour hub (chat window), not a separate window.
 * Opening it shows the hub and broadcasts `uiOpenActivity`, which the React
 * app turns into `setActiveView("activity")` (see App.tsx). The `forwarded`
 * guard stops the kernel's broadcast→event bridge from looping back into
 * `open()`. Mirrors the browser feature.
 */
export const activityFeature: Feature = {
	id: "activity",
	init(deps) {
		let forwarded = false;

		function open() {
			deps.events.emit("ui:open-chat", {});
			const route = () => {
				forwarded = true;
				broadcaster.broadcast("uiOpenActivity", {});
				setTimeout(() => { forwarded = false; }, 0);
			};
			setTimeout(route, 150);
			setTimeout(route, 400);
			setTimeout(route, 900);
		}

		deps.tray.addMenuItem(
			{ label: WINDOW_TARGET_META.activity.menuLabel, action: "activity:open", order: 25 },
			() => open(),
		);
		deps.events.on("ui:open-activity", () => {
			if (forwarded) return;
			open();
		});
	},
};
