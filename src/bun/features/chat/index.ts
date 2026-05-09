import { resolveViewUrl } from "../../kernel/view-url";
import type { Feature } from "../../kernel/registry";
import type { WindowHandle } from "../../kernel/windows";
import { setWindowControllerForRpc } from "../../core/rpc/window-controller-registry";
import type { WindowCommand } from "../../core/api/server";

const DEFAULT_WIDTH = 480;
const DEFAULT_HEIGHT = 720;

export const chatFeature: Feature = {
	id: "chat",
	init(deps) {
		let chatWindow: WindowHandle | null = null;
		let isShown = false;
		let pinned = false;
		let currentWidth = DEFAULT_WIDTH;
		let currentHeight = DEFAULT_HEIGHT;

		// Window control surface — invoked by both legacy HTTP (/api/window/*)
		// and typed RPC (windowHide / windowPin / windowResize). Both
		// transports drive this single callback; HTTP goes through the
		// ApiServer's setWindowController, RPC goes through the registry
		// in src/bun/core/rpc/window-controller-registry.ts.
		const handleWindowCommand = (cmd: WindowCommand) => {
			if (cmd.kind === "hide") {
				hide();
			} else if (cmd.kind === "pin") {
				pinned = cmd.on;
			} else if (cmd.kind === "resize") {
				currentWidth = cmd.width;
				currentHeight = cmd.height;
				if (chatWindow) {
					try {
						(chatWindow.window as unknown as { setSize?: (w: number, h: number) => void }).setSize?.(cmd.width, cmd.height);
					} catch {
						// best-effort; some Electrobun versions might not expose setSize
					}
				}
			}
		};
		deps.core.api.setWindowController(handleWindowCommand);
		setWindowControllerForRpc(handleWindowCommand);

		function ensureWindow(): WindowHandle {
			if (chatWindow) return chatWindow;
			// RPC handlers are mounted globally by WindowFactory via the
			// registry — no per-window handler block here. See
			// src/bun/core/rpc/registry.ts and docs/rpc-migration.md.
			const handle = deps.windows.createPopup({
				viewKey: "chat",
				width: currentWidth,
				height: currentHeight,
				url: resolveViewUrl(),
				hideOnBlur: false,
				alwaysOnTop: true,
			});
			handle.onClose(() => {
				chatWindow = null;
				isShown = false;
				pinned = false;
			});
			// Honor pin state on blur — only hide when not pinned (settings drawer open).
			handle.onBlur(() => {
				if (!pinned) hide();
			});
			chatWindow = handle;
			return handle;
		}

		function show() {
			const handle = ensureWindow();
			deps.windows.positionUnderTrayBounds(
				handle,
				deps.tray.getBounds(),
				currentWidth,
				currentHeight,
			);
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

		deps.tray.onIconClicked(() => toggle());
		deps.tray.addMenuItem(
			{ label: "Open Chat", action: "chat:open", order: 10 },
			() => toggle(),
		);

		deps.events.on("ui:open-chat", () => show());
		deps.events.on("ui:toggle-chat", () => toggle());
		// Settings menu now opens the drawer inside the chat window.
		deps.events.on("ui:open-settings", () => {
			show();
			// Best-effort: tell the React app to open its settings drawer.
			// Done via a custom WS message that the React app listens for.
			deps.core.api.publish({ kind: "ui:open-settings" });
		});
	},
};
