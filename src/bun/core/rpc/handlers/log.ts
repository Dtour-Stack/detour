import type { LogWebviewPayload } from "../../../../shared/rpc/log";
import type { RpcDeps } from "../types";

/**
 * View→bun message handlers. Replaces the WS `log:webview` path:
 * webview console.* / unhandled errors get forwarded here and logged
 * via ActivityLogService so they show up alongside main-process logs.
 */
export function viewMessages(deps: RpcDeps) {
	return {
		logWebview: (payload: LogWebviewPayload) => {
			deps.activity.logs.captureWebviewLog({
				level: payload.level,
				msg: payload.msg,
				...(payload.source ? { source: payload.source } : {}),
				...(payload.traceId ? { traceId: payload.traceId } : {}),
				...(payload.extras ? { extras: payload.extras } : {}),
			});
		},
	};
}
