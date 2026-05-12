/**
 * PortlessService — wraps the `portless` npm package as an in-process Detour
 * service. Boots the proxy on a non-privileged port and exposes the route
 * store so the API server / UI can list/add/remove named-localhost routes.
 *
 * v0 scope: HTTP only, non-privileged port (no sudo, no certs, no /etc/hosts
 * sync). Users who want HTTPS / port 443 / system service can keep using the
 * `portless` CLI separately. Detour just gives them a tray UI for the
 * everyday register/list/remove workflow.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { RouteStore, createProxyServer, type ProxyServer, type RouteMapping } from "portless";

const DEFAULT_PORTLESS_PORT = 4848;
const DEFAULT_TLD = "localhost";

export interface PortlessSnapshot {
	running: boolean;
	proxyPort: number;
	/** True when deferring to standalone portless on HTTPS (typically :443). */
	proxyHttps: boolean;
	tld: string;
	routes: RouteMapping[];
	bindError?: string | null;
}

export class PortlessService {
	private server: ProxyServer | null = null;
	private store: RouteStore;
	private proxyPort: number;
	private readonly tld: string;
	private readonly stateDir: string;
	private bindError: string | null = null;
	/**
	 * When true, an external portless daemon is already running (likely
	 * the system-wide install from https://portless.sh on port 80) and
	 * is reading the same RouteStore we write to. We skip our in-process
	 * proxy and let the external one route requests. URLs become
	 * port-less (`http://<slug>.localhost/`) — what portless is for.
	 */
	private externalProxyDetected = false;

	constructor(opts: { stateDir?: string; proxyPort?: number; tld?: string } = {}) {
		// Default to the canonical `~/.portless/` so we share the route
		// store with the standalone `portless` CLI / system service. That
		// way `portless list` and `portless proxy start` see our routes,
		// and (when the standalone daemon is running on 80/443) URLs
		// become port-less. Override via env if you really want isolated
		// state.
		this.stateDir = opts.stateDir
			?? process.env.DETOUR_PORTLESS_STATE_DIR
			?? join(homedir(), ".portless");
		this.proxyPort = opts.proxyPort ?? (Number(process.env.DETOUR_PORTLESS_PORT) || DEFAULT_PORTLESS_PORT);
		this.tld = opts.tld ?? DEFAULT_TLD;
		mkdirSync(this.stateDir, { recursive: true });
		this.store = new RouteStore(this.stateDir, {
			onWarning: (m) => console.warn(`[portless] ${m}`),
		});
	}

	private externalProxyTls = false;

	start(): void {
		if (this.server) return;
		// Probe for the standalone portless daemon on :443 (HTTPS) or
		// :80 (HTTP). Found → defer to it; URLs become port-less.
		// Not found → bind our own non-privileged port.
		void this.detectExternalProxy().then((detected) => {
			if (detected) {
				this.externalProxyDetected = true;
				this.proxyPort = detected.port;
				this.externalProxyTls = detected.tls;
				console.log(
					`[portless] external daemon detected on ${detected.tls ? "https" : "http"}://127.0.0.1:${detected.port}` +
					` — deferring (URLs port-less${detected.tls ? ", https" : ""})`,
				);
				return;
			}
			const candidates: number[] = [];
			for (let i = 0; i < 10; i++) candidates.push(this.proxyPort + i);
			this.tryBind(candidates, 0);
		}).catch(() => {
			const candidates: number[] = [];
			for (let i = 0; i < 10; i++) candidates.push(this.proxyPort + i);
			this.tryBind(candidates, 0);
		});
	}

	/**
	 * Probe for the standalone portless daemon. portless.sh defaults to
	 * HTTPS:443 with auto-elevated sudo; older / --no-tls installs use
	 * HTTP:80. We try 443 first (canonical), then 80, then give up and
	 * fall back to our in-process proxy.
	 */
	private async detectExternalProxy(): Promise<{ port: number; tls: boolean } | null> {
		const probeHost = `__detour_probe.${this.tld}`;
		const probe = async (url: string, port: number, tls: boolean): Promise<{ port: number; tls: boolean } | null> => {
			try {
				const ctl = new AbortController();
				const t = setTimeout(() => ctl.abort(), 600);
				const r = await fetch(url, {
					headers: { Host: probeHost },
					signal: ctl.signal,
					// portless's local-CA cert isn't trusted by our fetch,
					// but we only check headers — accept any response.
					tls: tls ? { rejectUnauthorized: false } : undefined,
				});
				clearTimeout(t);
				const hit = (r.headers.get("x-portless") ?? r.headers.get("X-Portless")) === "1";
				return hit ? { port, tls } : null;
			} catch {
				return null;
			}
		};
		return (await probe("https://127.0.0.1/", 443, true))
			?? (await probe("http://127.0.0.1/", 80, false));
	}

	private tryBind(candidates: number[], index: number): void {
		if (index >= candidates.length) {
			this.bindError = `failed to bind any port in [${candidates[0]}-${candidates[candidates.length - 1]}]`;
			console.warn(`[portless] ${this.bindError}`);
			return;
		}
		const port = candidates[index];
		const server = createProxyServer({
			getRoutes: () => this.store.loadRoutes(),
			proxyPort: port,
			tld: this.tld,
			strict: true,
			onError: (m) => console.warn(`[portless] proxy: ${m}`),
		});
		server.on("error", (err) => {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("EADDRINUSE") || msg.includes("address already in use")) {
				console.warn(`[portless] :${port} in use, trying next port…`);
				try { server.close(); } catch { /* ignore */ }
				this.tryBind(candidates, index + 1);
				return;
			}
			console.warn(`[portless] proxy bind failed on :${port}: ${msg}`);
			this.bindError = msg;
			this.server = null;
		});
		server.on("listening", () => {
			this.proxyPort = port;
			this.bindError = null;
			console.log(`[portless] proxy listening on http://127.0.0.1:${port} (tld=${this.tld})`);
		});
		server.listen(port, "127.0.0.1");
		this.server = server;
	}

	stop(): void {
		this.server?.close();
		this.server = null;
	}

	snapshot(): PortlessSnapshot {
		return {
			running: this.externalProxyDetected || (this.server !== null && this.bindError === null),
			proxyPort: this.proxyPort,
			proxyHttps: this.externalProxyDetected && this.externalProxyTls,
			tld: this.tld,
			routes: this.store.loadRoutes(),
			bindError: this.bindError,
		};
	}

	addRoute(hostname: string, port: number, opts: { force?: boolean } = {}): { killedPid?: number } {
		// Browsers downcase Host headers before matching. Normalize on
		// write so `Test`/`test`/`TEST` all collapse to one route.
		const normalized = hostname.toLowerCase();
		const killedPid = this.store.addRoute(normalized, port, process.pid, opts.force ?? false);
		return killedPid !== undefined ? { killedPid } : {};
	}

	removeRoute(hostname: string): void {
		this.store.removeRoute(hostname.toLowerCase());
	}

	pruneStale(): RouteMapping[] {
		return this.store.pruneStaleRoutes();
	}
}
