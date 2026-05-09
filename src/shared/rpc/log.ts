/**
 * View→bun log forwarding. Replaces the legacy `log:webview` WS message:
 * webview console.* and unhandled errors get forwarded to bun's
 * ActivityLogService so they show up in Activity > Logs alongside
 * main-process logs.
 *
 * Lives on the `webview.messages` channel (fire-and-forget, view→bun).
 * The bun-side handler is mounted via WindowFactory's
 * `defineRPC({ handlers: { messages: { logWebview: ... } } })`.
 */

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

export type LogWebviewPayload = {
	level: LogLevel;
	msg: string;
	source?: string;
	traceId?: string;
	extras?: Record<string, unknown>;
};

export type LogWebviewMessages = {
	logWebview: LogWebviewPayload;
};
