import { resolveViewUrl } from "../../kernel/view-url";
import type { Feature } from "../../kernel/registry";
import type { WindowHandle } from "../../kernel/windows";
import type { ChatRPC } from "./rpc-schema";

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

		// Window control surface — invoked by API endpoints (/api/window/*)
		deps.core.api.setWindowController((cmd) => {
			if (cmd.kind === "hide") {
				hide();
			} else if (cmd.kind === "pin") {
				pinned = cmd.on;
			} else if (cmd.kind === "resize") {
				currentWidth = cmd.width;
				currentHeight = cmd.height;
				if (chatWindow) {
					try {
						(chatWindow.window as any).setSize?.(cmd.width, cmd.height);
					} catch {
						// best-effort; some Electrobun versions might not expose setSize
					}
				}
			}
		});

		function ensureWindow(): WindowHandle {
			if (chatWindow) return chatWindow;
			const handle = deps.windows.createPopup({
				viewKey: "chat",
				width: currentWidth,
				height: currentHeight,
				url: resolveViewUrl(),
				hideOnBlur: false,
				alwaysOnTop: true,
				rpc: {
					maxRequestTime: 60_000,
					handlers: {
						// First migrated RPC method (per .claude/rules/electrobun.md
						// "Typed RPC" — replaces /api/backends HTTP fetch). The
						// handler delegates to the same VaultManager the HTTP route
						// uses, so the runtime-level behavior is identical;
						// migration of the call site lives in src/main/rpc.ts +
						// src/main/settings/BackendsTab.tsx. See docs/rpc-migration.md.
						requests: {
							vaultListBackends: async () => {
								const manager = await deps.core.vault.manager();
								return manager.detectBackends();
							},
						},
						messages: {},
					},
				},
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

export type { ChatRPC };
