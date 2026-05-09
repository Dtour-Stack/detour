/**
 * WebClient — slim WebSocket-only client. Post HTTP→RPC migration, the
 * only remaining bun↔view traffic that doesn't go through electrobun's
 * typed RPC bridge is the chat-streaming path (chat:send / chat:delta /
 * chat:complete / chat:error) and webview log forwarding (log:webview).
 * The legacy HTTP/JSON methods are gone — call sites use
 * `rpc.request.*` from src/main/rpc.ts via per-feature schemas in
 * src/shared/rpc/*.
 *
 * The remaining `client.connect/send/on` surface stays alive solely
 * because chat streaming hasn't been migrated to RPC `messages` yet
 * (intentionally out of scope, see docs/rpc-migration.md). When chat
 * streaming moves to RPC, this entire file goes away.
 */

import type { WsClientMessage, WsServerMessage } from "../../shared/index";

type Listener = (msg: WsServerMessage) => void;

// Re-exported types still consumed by view components via `import type`.
// They lived on this module historically; keeping the shape stable so
// downstream `import { LlamaServerStatus, ... } from "../api/client"`
// imports don't churn.
export interface InboxItem {
	readonly id: string;
	readonly time: number;
	readonly kind: string;
	readonly status: string;
	readonly title: string;
	readonly body: string;
	readonly source: string;
	readonly channel?: string;
	readonly fromHandle?: string;
	readonly entityId?: string;
	readonly prompted?: boolean;
	readonly replyText?: string;
	readonly meta?: Record<string, unknown>;
}

export interface GatewayMessage {
	readonly id: string;
	readonly time: number;
	readonly direction: "in" | "out" | "deleted" | "interaction";
	readonly channel: string;
	readonly source: string;
	readonly roomId: string;
	readonly entityId: string;
	readonly externalHandle?: string;
	readonly text: string;
	readonly meta?: Record<string, unknown>;
}

export interface GatewayIdentityCandidate {
	readonly key: string;
	readonly channel: string;
	readonly externalHandle: string;
	readonly entityIds: string[];
	readonly firstSeen: number;
	readonly lastSeen: number;
	readonly messageCount: number;
}

export interface LlamaServerStatus {
	readonly running: boolean;
	readonly url: string | null;
	readonly modelPath: string | null;
	readonly pid: number | null;
	readonly startedAt: number | null;
	readonly lastError: string | null;
	readonly downloadProgress?: { downloadedBytes: number; totalBytes: number; percent: number } | null;
}

export class WebClient {
	private ws: WebSocket | null = null;
	private listeners = new Set<Listener>();
	private outbox: WsClientMessage[] = [];

	// `window.__detourApiBase = "http://127.0.0.1:<port>"` is injected via
	// WindowFactory's preload — under views:// `location.host` would be
	// the view name, not the bun HTTP/WS server. We read that here as the
	// default base.
	constructor(private readonly base = typeof window !== "undefined"
		? ((window as unknown as { __detourApiBase?: string }).__detourApiBase ?? "")
		: "") {}

	async connect(): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
			const wsUrl = this.base
				? `${this.base.replace(/^http/, "ws")}/ws`
				: `${wsProto}//${location.host}/ws`;
			const ws = new WebSocket(wsUrl);
			ws.onopen = () => {
				this.ws = ws;
				for (const m of this.outbox.splice(0)) ws.send(JSON.stringify(m));
				installWebviewLogForwarder(this);
				resolve();
			};
			ws.onerror = reject;
			ws.onmessage = (ev) => {
				try {
					const msg = JSON.parse(ev.data) as WsServerMessage;
					for (const fn of this.listeners) fn(msg);
				} catch {
					// ignore
				}
			};
			ws.onclose = () => {
				this.ws = null;
				setTimeout(() => this.connect().catch(() => {}), 1000);
			};
		});
	}

	on(fn: Listener): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	send(msg: WsClientMessage): void {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(msg));
		} else {
			this.outbox.push(msg);
		}
	}
}

/**
 * Forward webview console output (and unhandled errors) to the server's
 * ActivityLogService so they appear alongside main-process logs in
 * Activity > Logs and the persisted JSONL file. Without this, JS errors
 * and console warnings inside chat / settings / pensieve windows are
 * invisible until the user manually opens DevTools.
 *
 * Idempotent: only patches console once even if connect() retries.
 */
let webviewLogForwarderInstalled = false;
let lastServerTraceId: string | undefined;

function installWebviewLogForwarder(client: WebClient): void {
	if (webviewLogForwarderInstalled) return;
	webviewLogForwarderInstalled = true;

	const view =
		typeof location !== "undefined"
			? (location.hash || "").replace(/^#/, "") || "chat"
			: "webview";

	// Pick up the trace id from any inbound chat:* message so subsequent
	// console.log calls during the same turn carry it.
	client.on((m) => {
		if (
			(m.kind === "chat:delta" || m.kind === "chat:complete" || m.kind === "chat:error") &&
			typeof (m as { traceId?: string }).traceId === "string"
		) {
			lastServerTraceId = (m as { traceId?: string }).traceId;
		}
	});

	const send = (
		level: "trace" | "debug" | "info" | "warn" | "error",
		args: unknown[],
	) => {
		try {
			const msg = args
				.map((a) =>
					typeof a === "string"
						? a
						: a instanceof Error
						? `${a.name}: ${a.message}`
						: (() => {
								try {
									return JSON.stringify(a);
								} catch {
									return String(a);
								}
						  })(),
				)
				.join(" ");
			client.send({
				kind: "log:webview",
				level,
				msg,
				source: `webview:${view}`,
				...(lastServerTraceId ? { traceId: lastServerTraceId } : {}),
			});
		} catch {
			/* ignore — never let logging break the page */
		}
	};

	for (const level of ["log", "info", "warn", "error", "debug"] as const) {
		const orig = console[level];
		console[level] = (...args: unknown[]) => {
			const lvl = level === "log" ? "info" : level;
			send(lvl, args);
			return orig.apply(console, args);
		};
	}

	if (typeof window !== "undefined") {
		window.addEventListener("error", (ev) => {
			send("error", [`${ev.message} @ ${ev.filename}:${ev.lineno}:${ev.colno}`]);
		});
		window.addEventListener("unhandledrejection", (ev) => {
			const r = ev.reason;
			send("error", [
				"unhandledrejection:",
				r instanceof Error ? `${r.name}: ${r.message}` : r,
			]);
		});
	}
}
