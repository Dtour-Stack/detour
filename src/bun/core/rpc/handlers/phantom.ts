import type { RpcDeps } from "../types";
import type { PortlessSnapshot } from "../../portless";

/**
 * Phantom Portal env (matches Portal UI: **Allowed Origins** + **Redirect URLs**):
 *
 * - `PHANTOM_CONNECT_APP_ID` — App ID from Portal (Integrations).
 * - `PHANTOM_CONNECT_REDIRECT_URL` — optional exact **Redirect URL** (also allowlisted
 *   in Portal). If unset, we derive one from `DETOUR_DEV_URL` + portless (see below).
 *
 * **Redirect URL resolution** (first match wins):
 * 1. `PHANTOM_CONNECT_REDIRECT_URL` — use as-is (normalized; add scheme if missing).
 * 2. `DETOUR_DEV_URL` points at a **non-local** host (tunnel / staging HTTPS) → use
 *    that origin as redirect (real public URL for Portal TXT + OAuth).
 * 3. `DETOUR_DEV_URL` + **portless running** → register `PHANTOM_PORTLESS_FQDN` or
 *    `<PHANTOM_PORTLESS_HOST>.<portless-tld>` → Vite port; redirect is the portless
 *    base URL (`https://…/` when standalone portless is on :443, else `http://…:port/`).
 * 4. `DETOUR_DEV_URL` only → `${DETOUR_DEV_URL}` origin + `/`.
 *
 * Portal **Allowed Origins** must include every origin the embedded SDK runs on
 * (see `phantomGetPortalConfig.portalAllowedOrigins`). **Redirect URLs** must include
 * the exact redirect string (`portalRedirectUrls`).
 */

const DEFAULT_PHANTOM_PORTLESS_HOST = "detour-phantom";

function parseDetourDevUrl(): URL | null {
	const raw = process.env.DETOUR_DEV_URL?.trim();
	if (!raw) return null;
	try {
		const normalized = /^(https?:)?\/\//i.test(raw) ? raw : `http://${raw}`;
		return new URL(normalized.endsWith("/") ? normalized.slice(0, -1) : normalized);
	} catch {
		return null;
	}
}

function devTargetPort(dev: URL): number {
	if (dev.port) return Number(dev.port);
	return dev.protocol === "https:" ? 443 : 80;
}

/** `localhost`, `*.localhost`, loopback — not “public” for Portal-only tunnels. */
function isLocalDevHost(hostname: string): boolean {
	const h = hostname.toLowerCase();
	if (h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1") return true;
	if (h.endsWith(".localhost")) return true;
	return false;
}

/** Normalize for Phantom Portal redirect allowlist. Root → `${origin}/`; non-root paths kept exact. */
function normalizePhantomRedirectUrl(raw: string): string | null {
	const t = raw.trim();
	if (!t) return null;
	try {
		const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`);
		if (!u.pathname || u.pathname === "/") return `${u.origin}/`;
		return u.href;
	} catch {
		return null;
	}
}

function portlessProxyBaseUrl(snap: PortlessSnapshot, host: string): string {
	const h = host.toLowerCase();
	if (snap.proxyHttps) {
		return snap.proxyPort === 443 ? `https://${h}/` : `https://${h}:${snap.proxyPort}/`;
	}
	return snap.proxyPort === 80 ? `http://${h}/` : `http://${h}:${snap.proxyPort}/`;
}

function buildPortalHints(redirectUrl: string | null, dev: URL | null): {
	portalAllowedOrigins: string[];
	portalRedirectUrls: string[];
} {
	const origins = new Set<string>();
	if (redirectUrl) {
		try {
			origins.add(new URL(redirectUrl).origin);
		} catch {
			/* ignore */
		}
	}
	if (dev) origins.add(dev.origin);
	const portalAllowedOrigins = [...origins].slice(0, 10);
	const portalRedirectUrls = redirectUrl ? [redirectUrl].slice(0, 10) : [];
	return { portalAllowedOrigins, portalRedirectUrls };
}

function resolvePhantomRedirectUrl(deps: RpcDeps): string | null {
	const explicitRaw = process.env.PHANTOM_CONNECT_REDIRECT_URL?.trim();
	if (explicitRaw) {
		return normalizePhantomRedirectUrl(explicitRaw);
	}

	const dev = parseDetourDevUrl();
	const snap = deps.portless.snapshot();
	const fqdn = process.env.PHANTOM_PORTLESS_FQDN?.trim().toLowerCase();
	const sub =
		(process.env.PHANTOM_PORTLESS_HOST ?? DEFAULT_PHANTOM_PORTLESS_HOST).trim().toLowerCase() ||
		DEFAULT_PHANTOM_PORTLESS_HOST;

	if (dev && !isLocalDevHost(dev.hostname)) {
		return normalizePhantomRedirectUrl(`${dev.origin}/`);
	}

	if (dev && snap.running) {
		const fq = fqdn || `${sub}.${snap.tld}`;
		const targetPort = devTargetPort(dev);
		deps.portless.addRoute(fq, targetPort, { force: true });
		return normalizePhantomRedirectUrl(portlessProxyBaseUrl(snap, fq));
	}

	if (dev) {
		return normalizePhantomRedirectUrl(`${dev.origin}/`);
	}

	return null;
}

export function phantomRequests(deps: RpcDeps) {
	return {
		phantomGetPortalConfig: async (): Promise<{
			appId: string | null;
			redirectUrl: string | null;
			portalAllowedOrigins: string[];
			portalRedirectUrls: string[];
		}> => {
			const appId = process.env.PHANTOM_CONNECT_APP_ID?.trim() || null;
			const dev = parseDetourDevUrl();
			const redirectUrl = resolvePhantomRedirectUrl(deps);
			const { portalAllowedOrigins, portalRedirectUrls } = buildPortalHints(redirectUrl, dev);
			return { appId, redirectUrl, portalAllowedOrigins, portalRedirectUrls };
		},
	};
}
