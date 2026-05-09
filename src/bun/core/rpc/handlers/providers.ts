import type { RpcDeps } from "../types";

// Providers requests live on the HTTP server today; this file is a stub
// that the providers+auth migration agent will fill. Server-push events
// (`provider:changed`) reach the webview via the WS→RPC bridge in
// registry.ts — agents migrating providers/auth replace the
// `this.broadcast({kind:"provider:changed", ...})` HTTP call sites with
// `deps.broadcaster.broadcast("providerChanged", {...})` directly.
export function providersRequests(_deps: RpcDeps) {
	return {} as const;
}
