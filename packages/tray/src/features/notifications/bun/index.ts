import { Utils } from "electrobun/bun";
import type { Feature } from "../../../bun/kernel/registry";

export const notificationsFeature: Feature = {
	id: "notifications",
	init(deps) {
		deps.events.on("notify", ({ title, body, subtitle }) => {
			try {
				Utils.showNotification({ title, body, subtitle });
			} catch (err) {
				console.error("[notifications] failed:", err);
			}
		});

		// Auto-notify on agent errors so the user sees them when the popup is hidden.
		deps.api.on((msg) => {
			if (msg.kind === "chat:error") {
				try {
					Utils.showNotification({
						title: "Eliza error",
						body: msg.message,
					});
				} catch {
					// best effort
				}
			}
		});
	},
};
