import { Utils } from "electrobun/bun";
import { registerWindow } from "../../core/rpc/registry";
import type { Feature } from "../../kernel/registry";

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
		// Hooks into the typed-RPC broadcaster: every `chatError` push fans out to
		// every registered window send fn, including this in-process faux-send,
		// which lets us surface the error as a system notification.
		registerWindow((name, payload) => {
			if (name !== "chatError") return;
			const message = (payload as { message?: string } | null)?.message ?? "";
			try {
				Utils.showNotification({
					title: "Detour error",
					body: message,
				});
			} catch {
				// best effort
			}
		});
	},
};
