import { BrowserView, BrowserWindow, Screen } from "electrobun/bun";

type RpcConfig = {
	maxRequestTime?: number;
	handlers: {
		requests?: Record<string, (params: any) => any>;
		messages?: Record<string, (payload: any) => any>;
	};
};

type RPCInstance = ReturnType<typeof BrowserView.defineRPC>;

export type WindowHandle = {
	window: BrowserWindow<RPCInstance>;
	rpc: RPCInstance;
	send<K extends string>(messageName: K, payload: unknown): void;
	close(): void;
	show(): void;
	hide(): void;
	focus(): void;
	onDomReady(handler: () => void): void;
	onClose(handler: () => void): void;
	onBlur(handler: () => void): void;
};

function makeHandle(
	window: BrowserWindow<RPCInstance>,
	rpc: RPCInstance,
	pendingFlush: { ready: boolean; queue: Array<[string, unknown]> },
): WindowHandle {
	return {
		window,
		rpc,
		send: (messageName, payload) => {
			if (!pendingFlush.ready) {
				pendingFlush.queue.push([messageName, payload]);
				return;
			}
			const send = (window.webview.rpc as any)?.send;
			send?.[messageName]?.(payload);
		},
		close: () => window.close(),
		show: () => window.show(),
		hide: () => window.hide(),
		focus: () => window.activate(),
		onDomReady: (handler) => window.webview.on("dom-ready", handler),
		onClose: (handler) => window.on("close", handler),
		onBlur: (handler) => window.on("blur", handler),
	};
}

function attachReadyFlush(handle: WindowHandle, pendingFlush: { ready: boolean; queue: Array<[string, unknown]> }) {
	handle.onDomReady(() => {
		pendingFlush.ready = true;
		const send = (handle.window.webview.rpc as any)?.send;
		for (const [name, payload] of pendingFlush.queue.splice(0)) {
			send?.[name]?.(payload);
		}
	});
}

export type PopupOptions = {
	viewKey: string;
	width: number;
	height: number;
	rpc: RpcConfig;
	hideOnBlur?: boolean;
	alwaysOnTop?: boolean;
	/** Override the default `views://<viewKey>/index.html` URL. Useful for pointing at a Vite dev server. */
	url?: string;
};

export type RegularWindowOptions = {
	viewKey: string;
	title: string;
	width: number;
	height: number;
	rpc: RpcConfig;
	centered?: boolean;
	/** Override the default `views://<viewKey>/index.html` URL. Useful for pointing at a Vite dev server. */
	url?: string;
};

export class WindowFactory {
	constructor(private readonly apiBase: string) {}

	private preload(): string {
		// Runs in the page context BEFORE any of the page's scripts. Sets
		// the API base URL the React app needs to talk to bun's HTTP/WS
		// server — `location.host` under views:// is the view name, not
		// the API host, so we have to inject this explicitly.
		return `window.__detourApiBase = ${JSON.stringify(this.apiBase)};`;
	}

	createPopup(opts: PopupOptions): WindowHandle {
		const rpc = BrowserView.defineRPC(opts.rpc as any);
		const window = new BrowserWindow({
			title: "",
			url: opts.url ?? `views://${opts.viewKey}/index.html`,
			html: null,
			preload: this.preload(),
			viewsRoot: null,
			renderer: "native",
			rpc,
			titleBarStyle: "hidden",
			transparent: false,
			passthrough: false,
			hidden: true,
			navigationRules: null,
			sandbox: false,
			frame: { x: 0, y: 0, width: opts.width, height: opts.height },
		});
		if (opts.alwaysOnTop ?? true) window.setAlwaysOnTop(true);
		const pendingFlush = { ready: false, queue: [] as Array<[string, unknown]> };
		const handle = makeHandle(window as any, rpc, pendingFlush);
		attachReadyFlush(handle, pendingFlush);
		return handle;
	}

	createWindow(opts: RegularWindowOptions): WindowHandle {
		const rpc = BrowserView.defineRPC(opts.rpc as any);
		const display = Screen.getPrimaryDisplay();
		const x = opts.centered
			? Math.round((display.bounds.width - opts.width) / 2)
			: 100;
		const y = opts.centered
			? Math.round((display.bounds.height - opts.height) / 2)
			: 100;
		const window = new BrowserWindow({
			title: opts.title,
			url: opts.url ?? `views://${opts.viewKey}/index.html`,
			html: null,
			preload: this.preload(),
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
		const pendingFlush = { ready: false, queue: [] as Array<[string, unknown]> };
		const handle = makeHandle(window as any, rpc, pendingFlush);
		attachReadyFlush(handle, pendingFlush);
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
