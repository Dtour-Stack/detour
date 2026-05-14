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
 * 5. Bundled app shell → `views://main/index.html`.
 *
 * Portal **Allowed Origins** must include every origin the embedded SDK runs on
 * (see `phantomGetPortalConfig.portalAllowedOrigins`). **Redirect URLs** must include
 * the exact redirect string (`portalRedirectUrls`).
 */

const DEFAULT_PHANTOM_PORTLESS_HOST = "detour-phantom";
const BUNDLED_PHANTOM_REDIRECT_URL = "views://main/index.html";

type PhantomPortalConfigInput = {
	appIdRaw: string | null | undefined;
	explicitRedirectUrlRaw: string | null | undefined;
	detourDevUrlRaw: string | null | undefined;
	phantomPortlessFqdnRaw: string | null | undefined;
	phantomPortlessHostRaw: string | null | undefined;
	portlessSnapshot: PortlessSnapshot;
	addPortlessRoute: (hostname: string, port: number) => void;
};

type PhantomPortalConfig = {
	appId: string | null;
	redirectUrl: string | null;
	portalAllowedOrigins: string[];
	portalRedirectUrls: string[];
};

function parseDetourDevUrl(rawValue: string | null | undefined): URL | null {
	const raw = rawValue?.trim();
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
		if ((u.protocol === "http:" || u.protocol === "https:") && (!u.pathname || u.pathname === "/")) {
			return `${u.origin}/`;
		}
		return u.href;
	} catch {
		return null;
	}
}

function portalOriginForUrl(raw: string): string | null {
	try {
		const u = new URL(raw);
		if (u.protocol === "http:" || u.protocol === "https:") return u.origin;
		if (u.host) return `${u.protocol}//${u.host}`;
		return null;
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
		const origin = portalOriginForUrl(redirectUrl);
		if (origin) origins.add(origin);
	}
	if (dev) origins.add(dev.origin);
	const portalAllowedOrigins = [...origins].slice(0, 10);
	const portalRedirectUrls = redirectUrl ? [redirectUrl].slice(0, 10) : [];
	return { portalAllowedOrigins, portalRedirectUrls };
}

function resolvePhantomRedirectUrl(input: PhantomPortalConfigInput): { redirectUrl: string; dev: URL | null } {
	const explicitRaw = input.explicitRedirectUrlRaw?.trim();
	if (explicitRaw) {
		const explicit = normalizePhantomRedirectUrl(explicitRaw);
		if (!explicit) throw new Error("Invalid PHANTOM_CONNECT_REDIRECT_URL");
		return { redirectUrl: explicit, dev: parseDetourDevUrl(input.detourDevUrlRaw) };
	}

	const dev = parseDetourDevUrl(input.detourDevUrlRaw);
	const snap = input.portlessSnapshot;
	const fqdn = input.phantomPortlessFqdnRaw?.trim().toLowerCase();
	const sub =
		(input.phantomPortlessHostRaw ?? DEFAULT_PHANTOM_PORTLESS_HOST).trim().toLowerCase() ||
		DEFAULT_PHANTOM_PORTLESS_HOST;

	if (dev && !isLocalDevHost(dev.hostname)) {
		return { redirectUrl: normalizePhantomRedirectUrl(`${dev.origin}/`) ?? `${dev.origin}/`, dev };
	}

	if (dev && snap.running) {
		const fq = fqdn || `${sub}.${snap.tld}`;
		const targetPort = devTargetPort(dev);
		input.addPortlessRoute(fq, targetPort);
		return { redirectUrl: normalizePhantomRedirectUrl(portlessProxyBaseUrl(snap, fq)) ?? portlessProxyBaseUrl(snap, fq), dev };
	}

	if (dev) {
		return { redirectUrl: normalizePhantomRedirectUrl(`${dev.origin}/`) ?? `${dev.origin}/`, dev };
	}

	return { redirectUrl: BUNDLED_PHANTOM_REDIRECT_URL, dev: null };
}

export function resolvePhantomPortalConfig(input: PhantomPortalConfigInput): PhantomPortalConfig {
	const appId = input.appIdRaw?.trim() || null;
	const { redirectUrl, dev } = resolvePhantomRedirectUrl(input);
	const { portalAllowedOrigins, portalRedirectUrls } = buildPortalHints(redirectUrl, dev);
	return { appId, redirectUrl, portalAllowedOrigins, portalRedirectUrls };
}

export function phantomRequests(deps: RpcDeps) {
	return {
		phantomGetPortalConfig: async (): Promise<PhantomPortalConfig> => {
			return resolvePhantomPortalConfig({
				appIdRaw: process.env.PHANTOM_CONNECT_APP_ID,
				explicitRedirectUrlRaw: process.env.PHANTOM_CONNECT_REDIRECT_URL,
				detourDevUrlRaw: process.env.DETOUR_DEV_URL,
				phantomPortlessFqdnRaw: process.env.PHANTOM_PORTLESS_FQDN,
				phantomPortlessHostRaw: process.env.PHANTOM_PORTLESS_HOST,
				portlessSnapshot: deps.portless.snapshot(),
				addPortlessRoute: (hostname, port) => {
					deps.portless.addRoute(hostname, port, { force: true });
				},
			});
		},
	};
}
