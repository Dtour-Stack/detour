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
	tld: string;
	routes: RouteMapping[];
}

export class PortlessService {
	private server: ProxyServer | null = null;
	private store: RouteStore;
	private readonly proxyPort: number;
	private readonly tld: string;
	private readonly stateDir: string;

	constructor(opts: { stateDir?: string; proxyPort?: number; tld?: string } = {}) {
		this.stateDir = opts.stateDir ?? join(homedir(), ".detour", "portless");
		this.proxyPort = opts.proxyPort ?? (Number(process.env.DETOUR_PORTLESS_PORT) || DEFAULT_PORTLESS_PORT);
		this.tld = opts.tld ?? DEFAULT_TLD;
		mkdirSync(this.stateDir, { recursive: true });
		this.store = new RouteStore(this.stateDir, {
			onWarning: (m) => console.warn(`[portless] ${m}`),
		});
	}

	start(): void {
		if (this.server) return;
		const server = createProxyServer({
			getRoutes: () => this.store.loadRoutes(),
			proxyPort: this.proxyPort,
			tld: this.tld,
			strict: true,
			onError: (m) => console.warn(`[portless] proxy: ${m}`),
		});
		// Catch bind errors (EADDRINUSE etc.) so a port collision doesn't
		// uncaughtException out of the parent boot. Detour stays usable
		// even if the proxy can't bind — the user just loses the proxy UI.
		server.on("error", (err) => {
			console.warn(`[portless] proxy bind failed: ${err instanceof Error ? err.message : String(err)}`);
			this.server = null;
		});
		server.on("listening", () => {
			console.log(`[portless] proxy listening on http://127.0.0.1:${this.proxyPort} (tld=${this.tld})`);
		});
		server.listen(this.proxyPort, "127.0.0.1");
		this.server = server;
	}

	stop(): void {
		this.server?.close();
		this.server = null;
	}

	snapshot(): PortlessSnapshot {
		return {
			running: this.server !== null,
			proxyPort: this.proxyPort,
			tld: this.tld,
			routes: this.store.loadRoutes(),
		};
	}

	addRoute(hostname: string, port: number, opts: { force?: boolean } = {}): { killedPid?: number } {
		const killedPid = this.store.addRoute(hostname, port, process.pid, opts.force ?? false);
		return killedPid !== undefined ? { killedPid } : {};
	}

	removeRoute(hostname: string): void {
		this.store.removeRoute(hostname);
	}

	pruneStale(): RouteMapping[] {
		return this.store.pruneStaleRoutes();
	}
}
