/**
 * View-side typed RPC singleton — canonical IPC per
 * .claude/rules/electrobun.md. All view↔bun traffic flows through
 * electrobun's native postMessage bridge:
 *
 *   - rpc.request.<name>(...)  view → bun (awaitable)
 *   - rpc.send.<name>(...)     view → bun (fire-and-forget)
 *   - bun → view broadcasts arrive at handlers in
 *     `src/main/rpc-listeners/<group>.ts` (composed via
 *     `buildViewListeners` below).
 */

import Electrobun, { Electroview } from "electrobun/view";
import type { DetourRPC } from "../shared/rpc";
import { RPC_TIMING_MS } from "../shared/timing";
import { buildViewListeners } from "./rpc-listeners";
import { phantomViewRequestHandlers } from "./wallet/phantom-view-handlers";

const rpcDef = Electroview.defineRPC<DetourRPC>({
	maxRequestTime: RPC_TIMING_MS.maxRequest,
	handlers: {
		// Bun → view awaitable RPC (Phantom wallet, etc.). View → bun traffic
		// remains `request` / `send` on the same bridge; see
		// docs/rpc-migration.md.
		requests: phantomViewRequestHandlers,
		messages: buildViewListeners(),
	},
});

const electroview = new Electrobun.Electroview({ rpc: rpcDef });

let webviewLogForwarderInstalled = false;
let lastServerTraceId: string | undefined;

export const rpc = rpcDef;
export const view = electroview;

installWebviewLogForwarder();

/**
 * Forward webview console output (and unhandled errors) to the bun-side
 * ActivityLogService so they show up alongside main-process logs in
 * Activity > Logs and the persisted JSONL file. Without this, JS errors
 * and console warnings inside chat / settings / pensieve windows are
 * invisible until the user manually opens DevTools.
 *
 * Forwarding goes over typed RPC via `view.rpc.send.logWebview`.
 */
function installWebviewLogForwarder(): void {
	if (webviewLogForwarderInstalled) return;
	webviewLogForwarderInstalled = true;

	const view =
		typeof location !== "undefined"
			? (location.hash || "").replace(/^#/, "") || "chat"
			: "webview";

	// Pick up the trace id from any inbound chat:* message so subsequent
	// console.log calls during the same turn carry it. The chat-streaming
	// listeners below dispatch via the rpc-listeners/chat module; this
	// just shadows the trace id from those payloads.
	import("./rpc-listeners/chat").then(({ onChatComplete, onChatDelta, onChatError }) => {
		const stamp = (p: { traceId?: string }) => {
			if (typeof p.traceId === "string") lastServerTraceId = p.traceId;
		};
		onChatDelta(stamp);
		onChatComplete(stamp);
		onChatError(stamp);
	}).catch(() => {});

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
			(rpcDef as unknown as { send: { logWebview: (p: unknown) => void } }).send.logWebview({
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
