/**
 * Process-wide trace context.
 *
 * Every "request" — a chat send, an inbox post, a cron fire, a credential
 * save, an API call — opens a `traceScope(traceId, fn)`. Inside that scope,
 * `getTraceId()` returns the active trace id from AsyncLocalStorage so
 * downstream code can stamp it onto:
 *   - `logger.info({ traceId, ... }, "...")` entries (which the
 *     ActivityLogService picks up via the existing `extras` capture)
 *   - WS messages back to the webview (chat:delta carries a traceId so
 *     the React side can stitch logs to a particular send)
 *   - Webview console.log forwards (the client tags each forwarded line
 *     with the active hash route + trace id when the user starts a chat
 *     send).
 *
 * Why no OpenTelemetry: the code paths we care about all live in this
 * single bun process plus llama-server (which has its own self-contained
 * stderr) plus webviews (which talk back over the WS we already own). A
 * 6-line ALS helper is enough; an SDK would dwarf the rest of the runtime.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<string>();

/**
 * Generate a short, sortable, human-readable trace id.
 * Pattern: `<base36 ms>-<6 hex chars>` so traces are time-orderable in `tail`/`grep`.
 * Example: `mu7e9wqv-a3f12c`.
 */
export function newTraceId(): string {
	const t = Date.now().toString(36);
	const rand = Array.from(crypto.getRandomValues(new Uint8Array(3)))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `${t}-${rand}`;
}

/**
 * Run `fn` with `traceId` bound to the async context. Nested calls inherit
 * the outer trace id unless they call `traceScope()` again.
 */
export function traceScope<T>(traceId: string, fn: () => T | Promise<T>): T | Promise<T> {
	return store.run(traceId, fn);
}

/** The active trace id, or `undefined` when called outside any traced scope. */
export function getTraceId(): string | undefined {
	return store.getStore();
}

/** Convenience: ensure we have a trace id, generating one if absent. */
export function ensureTraceId(): string {
	return getTraceId() ?? newTraceId();
}
