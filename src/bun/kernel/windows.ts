/**
 * WindowFactory — typed wrapper around BrowserWindow + RPC for every
 * webview Detour creates. All windows share a single typed schema
 * (DetourRPC, composed in src/shared/rpc/) and a single handler bag
 * (built by src/bun/core/rpc/registry.ts), so any RPC method works
 * from any webview — not just the chat window.
 *
 * Per .claude/rules/electrobun.md ("Don't Use `as any` for RPC Types"),
 * this file uses Schema generics throughout — there are no `as any`
 * casts on RPC-typed paths.
 */

import { BrowserView, BrowserWindow, Screen } from "electrobun/bun";
import type { DetourRPC } from "../../shared/rpc";
import { buildRpcHandlers, registerWindow } from "../core/rpc/registry";
import type { RpcDeps } from "../core/rpc/types";

type DefinedRPC = ReturnType<typeof BrowserView.defineRPC<DetourRPC>>;
type RpcSendFn = (name: string, payload: unknown) => void;

type DetourBrowserWindow = BrowserWindow<DefinedRPC>;

export type WindowHandle = {
	window: DetourBrowserWindow;
	rpc: DefinedRPC;
	/**
	 * Push a typed message into this specific window. Most callers
	 * should use the broadcaster (which fans out to all windows) — use
	 * this only when the target window is the same one the caller owns.
	 */
	send<K extends keyof DetourRPC["bun"]["messages"]>(
		messageName: K,
		payload: DetourRPC["bun"]["messages"][K],
	): void;
	close(): void;
	show(): void;
	hide(): void;
	focus(): void;
	onDomReady(handler: () => void): void;
	onClose(handler: () => void): void;
	onBlur(handler: () => void): void;
};

type PendingFlush = { ready: boolean; queue: Array<[string, unknown]> };

type SendProxy = Record<string, ((payload: unknown) => void) | undefined>;

function getSendProxy(window: DetourBrowserWindow): SendProxy | undefined {
	// The typed `send` proxy is keyed only by known message names; cast
	// to a string-indexed callable bag for dynamic broadcasting. Type
	// safety is enforced at the schema level — registry only emits
	// names declared in src/shared/rpc/<group>.ts.
	return window.webview.rpc?.send as unknown as SendProxy | undefined;
}

function makeHandle(
	window: DetourBrowserWindow,
	rpc: DefinedRPC,
	pendingFlush: PendingFlush,
): WindowHandle {
	const sendRaw: RpcSendFn = (messageName, payload) => {
		if (!pendingFlush.ready) {
			pendingFlush.queue.push([messageName, payload]);
			return;
		}
		const send = getSendProxy(window);
		send?.[messageName]?.(payload);
	};
	return {
		window,
		rpc,
		send: ((messageName: string, payload: unknown) => sendRaw(messageName, payload)) as WindowHandle["send"],
		close: () => window.close(),
		show: () => window.show(),
		hide: () => window.hide(),
		focus: () => window.activate(),
		onDomReady: (handler) => window.webview.on("dom-ready", handler),
		onClose: (handler) => window.on("close", handler),
		onBlur: (handler) => window.on("blur", handler),
	};
}

function attachReadyFlush(handle: WindowHandle, pendingFlush: PendingFlush) {
	handle.onDomReady(() => {
		pendingFlush.ready = true;
		const send = getSendProxy(handle.window);
		for (const [name, payload] of pendingFlush.queue.splice(0)) {
			send?.[name]?.(payload);
		}
	});
}

export type PopupOptions = {
	viewKey: string;
	width: number;
	height: number;
	hideOnBlur?: boolean;
	alwaysOnTop?: boolean;
	/** Transparent window backdrop. Used by the Codex pet so the
	 * sprite renders without a card behind it. Implies frameless +
	 * passthrough off (the pet window still receives pointer events
	 * for drag/menu). */
	transparent?: boolean;
	/** Override the default `views://<viewKey>/index.html` URL. Useful for pointing at a Vite dev server. */
	url?: string;
};

export type RegularWindowOptions = {
	viewKey: string;
	title: string;
	width: number;
	height: number;
	centered?: boolean;
	/** Override the default `views://<viewKey>/index.html` URL. Useful for pointing at a Vite dev server. */
	url?: string;
};

export class WindowFactory {
	constructor(
		private readonly rpcDeps: RpcDeps,
	) {}

	private buildRpc(): DefinedRPC {
		return BrowserView.defineRPC<DetourRPC>({
			// 5 minutes — covers preview-server boot (`bun install` +
			// `bun dev`), portless proxy probes, large file tree builds,
			// and trajectory-detail fetches across thousands of records.
			// Chat sends are fire-and-forget so the streamed turn isn't
			// gated on this anymore, but other RPCs occasionally need
			// real time. Don't go higher without surfacing a UX
			// indicator — silent 5-minute hangs are bad enough.
			maxRequestTime: 5 * 60_000,
			handlers: buildRpcHandlers(this.rpcDeps),
		});
	}

	/** Hook the window into the broadcaster on dom-ready, unhook on close. */
	private wireBroadcastRegistration(handle: WindowHandle): void {
		let unregister: (() => void) | null = null;
		handle.onDomReady(() => {
			const send = getSendProxy(handle.window);
			if (!send) return;
			const sendFn: RpcSendFn = (name, payload) => send[name]?.(payload);
			unregister = registerWindow(sendFn);
		});
		handle.onClose(() => {
			unregister?.();
			unregister = null;
		});
	}

	createPopup(opts: PopupOptions): WindowHandle {
		const rpc = this.buildRpc();
		const window = new BrowserWindow<DefinedRPC>({
			title: "",
			url: opts.url ?? `views://${opts.viewKey}/index.html`,
			html: null,
			viewsRoot: null,
			renderer: "native",
			rpc,
			titleBarStyle: "hidden",
			transparent: opts.transparent ?? false,
			passthrough: false,
			hidden: true,
			navigationRules: null,
			sandbox: false,
			frame: { x: 0, y: 0, width: opts.width, height: opts.height },
		});
		if (opts.alwaysOnTop ?? true) window.setAlwaysOnTop(true);
		const pendingFlush: PendingFlush = { ready: false, queue: [] };
		const handle = makeHandle(window, rpc, pendingFlush);
		attachReadyFlush(handle, pendingFlush);
		this.wireBroadcastRegistration(handle);
		return handle;
	}

	createWindow(opts: RegularWindowOptions): WindowHandle {
		const rpc = this.buildRpc();
		const display = Screen.getPrimaryDisplay();
		const x = opts.centered
			? Math.round((display.bounds.width - opts.width) / 2)
			: 100;
		const y = opts.centered
			? Math.round((display.bounds.height - opts.height) / 2)
			: 100;
		const window = new BrowserWindow<DefinedRPC>({
			title: opts.title,
			url: opts.url ?? `views://${opts.viewKey}/index.html`,
			html: null,
			viewsRoot: null,
			renderer: "native",
			rpc,
			titleBarStyle: "default",
			transparent: false,
			passthrough: false,
			hidden: false,
			navigationRules: null,
			sandbox: false,
			frame: { x, y, width: opts.width, height: opts.height },
		});
		const pendingFlush: PendingFlush = { ready: false, queue: [] };
		const handle = makeHandle(window, rpc, pendingFlush);
		attachReadyFlush(handle, pendingFlush);
		this.wireBroadcastRegistration(handle);
		return handle;
	}

	positionUnderTrayBounds(
		handle: WindowHandle,
		bounds: { x: number; y: number; width: number; height: number },
		windowWidth: number,
		windowHeight: number,
		gap = 4,
	) {
		const display = Screen.getPrimaryDisplay();
		const x = Math.round(bounds.x + bounds.width / 2 - windowWidth / 2);
		const y = Math.round(bounds.y - windowHeight - gap);
		const clampedX = Math.max(0, Math.min(x, display.bounds.width - windowWidth));
		const clampedY = Math.max(0, Math.min(y, display.bounds.height - windowHeight));
		handle.window.setPosition(clampedX, clampedY);
	}
}
