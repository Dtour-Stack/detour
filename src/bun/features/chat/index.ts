import { resolveViewUrl } from "../../kernel/view-url";
import type { Feature } from "../../kernel/registry";
import type { WindowHandle } from "../../kernel/windows";
import { broadcaster } from "../../core/rpc/registry";
import { setWindowControllerForRpc } from "../../core/rpc/window-controller-registry";
import type { WindowCommand } from "../../core/api/server";
import { WINDOW_TARGET_META } from "../../../shared/window-targets";

// Centered medium-sized chat hub. Was 480x720 tray popup pre-channels-
// merge; now a regular framed window that hosts the agent chat plus a
// right-side rail of channel feeds (Discord / Telegram / iMessage /
// GitHub / in-app). Draggable, resizable, settings drawer still slides
// in from the right.
const DEFAULT_WIDTH = 960;
const DEFAULT_HEIGHT = 720;

export const chatFeature: Feature = {
	id: "chat",
	init(deps) {
		let chatWindow: WindowHandle | null = null;
		let isShown = false;
		let currentWidth = DEFAULT_WIDTH;
		let currentHeight = DEFAULT_HEIGHT;

		// Window control surface — invoked by typed RPC (windowHide /
		// windowPin / windowResize) via the registry in
		// src/bun/core/rpc/window-controller-registry.ts.
		// `pin` is a no-op now that the window is regular-framed (no
		// hide-on-blur to suppress); kept for back-compat with the
		// existing settings-drawer toggle code.
		const handleWindowCommand = (cmd: WindowCommand) => {
			if (cmd.kind === "hide") {
				hide();
			} else if (cmd.kind === "pin") {
				/* no-op — window stays open until user closes it. */
			} else if (cmd.kind === "resize") {
				currentWidth = cmd.width;
				currentHeight = cmd.height;
				if (chatWindow) {
					try {
						const win = chatWindow.window as unknown as Record<string, unknown>;
						if (typeof win.setSize === "function") {
							(win.setSize as (w: number, h: number) => void)(cmd.width, cmd.height);
						}
					} catch {
						/* best-effort; some Electrobun versions might not expose setSize */
					}
				}
			}
		};
		setWindowControllerForRpc(handleWindowCommand);

		function ensureWindow(): WindowHandle {
			if (chatWindow) return chatWindow;
			// RPC handlers are mounted globally by WindowFactory via the
			// registry — no per-window handler block here. See
			// src/bun/core/rpc/registry.ts and docs/rpc-migration.md.
			const handle = deps.windows.createWindow({
				viewKey: "chat",
				title: "Detour",
				width: currentWidth,
				height: currentHeight,
				centered: true,
				url: resolveViewUrl(),
			});
			handle.onClose(() => {
				chatWindow = null;
				isShown = false;
			});
			chatWindow = handle;
			return handle;
		}

		function show() {
			const handle = ensureWindow();
			handle.show();
			handle.focus();
			isShown = true;
		}

		function hide() {
			if (!chatWindow || !isShown) return;
			chatWindow.hide();
			isShown = false;
		}

		function toggle() {
			if (isShown) hide();
			else show();
		}

		// Tray-icon click is owned by the capsule entrypoint; the chat menu
		// item stays so right-click still has the canonical hub entry.
		deps.tray.addMenuItem(
			{ label: WINDOW_TARGET_META.chat.menuLabel, action: "chat:open", order: 20 },
			() => toggle(),
		);

		deps.events.on("ui:open-chat", () => show());
		deps.events.on("ui:toggle-chat", () => toggle());
		// Settings menu now opens the drawer inside the chat window.
		deps.events.on("ui:open-settings", () => {
			show();
			// Tell the React app (in every open window) to open its settings
			// drawer. Fans out via the typed-RPC broadcaster — the chat
			// window subscribes through `onUiOpenSettings` in
			// src/main/rpc-listeners/chat.ts.
			broadcaster.broadcast("uiOpenSettings", {});
		});
	},
};
