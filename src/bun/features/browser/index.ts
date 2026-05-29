import type { Feature } from "../../kernel/registry";
import { broadcaster } from "../../core/rpc/registry";
import { WINDOW_TARGET_META } from "../../../shared/window-targets";

export const browserFeature: Feature = {
	id: "browser",
	init(deps) {
		let forwarded = false;

		function open() {
			deps.events.emit("ui:open-chat", {});
			const route = () => {
				forwarded = true;
				broadcaster.broadcast("uiOpenBrowser", {});
				setTimeout(() => { forwarded = false; }, 0);
			};
			setTimeout(route, 150);
			setTimeout(route, 400);
			setTimeout(route, 900);
		}

		deps.tray.addMenuItem(
			{ label: WINDOW_TARGET_META.browser.menuLabel, action: "browser:open", order: 28 },
			() => open(),
		);
		deps.events.on("ui:open-browser", () => {
			if (forwarded) return;
			open();
		});
	},
};
