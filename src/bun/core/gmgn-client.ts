/**
 * GMGN OpenAPI HTTP client — shared between the agent plugin
 * (src/bun/plugins/gmgn-tools) and any bun-side RPC that needs to talk
 * to openapi.gmgn.ai (e.g. the wallet-stats UI handler).
 *
 * Auth contract:
 *   - GMGN_API_KEY → X-APIKEY header (always required).
 *   - GMGN_PRIVATE_KEY → X-Signature header on critical endpoints
 *     (/v1/trade/*, /v1/cooking/create_token). Ed25519 (raw bytes) or
 *     RSA-PSS SHA-256 (saltLen 32). Canonical message:
 *     `${subPath}:${sortedQs}:${body}:${timestamp}`.
 *   - Every request carries `timestamp` (unix sec, server window ±5s)
 *     and `client_id` (uuid; replay window 7s) as query params.
 *
 * `loadGmgnConfig()` returns `{ configured: false }` when GMGN_API_KEY
 * is missing so callers can render a "set up" affordance instead of
 * throwing a hard error from the UI.
 */

import {
	constants as cryptoConstants,
	createPrivateKey,
	randomUUID,
	sign as cryptoSign,
} from "node:crypto";

export const GMGN_BASE = "https://openapi.gmgn.ai";

export type GmgnQueryValue = string | number | boolean | string[];

export type GmgnConfigState =
	| { configured: false; reason: string }
	| {
			configured: true;
			apiKey: string;
			privateKeyPem: string | null;
	  };

export function loadGmgnConfig(): GmgnConfigState {
	const apiKey = process.env.GMGN_API_KEY?.trim();
	if (!apiKey) {
		return {
			configured: false,
			reason: "GMGN_API_KEY missing — set it in the repo .env (see https://gmgn.ai/ai) and restart Detour.",
		};
	}
	const privateKey = process.env.GMGN_PRIVATE_KEY?.trim();
	return {
		configured: true,
		apiKey,
		privateKeyPem: privateKey ? privateKey.replace(/\\n/g, "\n") : null,
	};
}

type SignAlgo = "Ed25519" | "RSA-SHA256";

function detectAlgo(pem: string): SignAlgo {
	const key = createPrivateKey(pem);
	const t = (key as unknown as { asymmetricKeyType?: string }).asymmetricKeyType;
	if (t === "ed25519") return "Ed25519";
	if (t === "rsa") return "RSA-SHA256";
	throw new Error(`Unsupported GMGN_PRIVATE_KEY type: ${t} (need ed25519 or rsa)`);
}

export function signMessage(message: string, pem: string): string {
	const algo = detectAlgo(pem);
	const buf = Buffer.from(message, "utf8");
	if (algo === "Ed25519") {
		return cryptoSign(null, buf, pem).toString("base64");
	}
	return cryptoSign("sha256", buf, {
		key: pem,
		padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
		saltLength: 32,
	}).toString("base64");
}

function buildUrl(subPath: string, query: Record<string, GmgnQueryValue | undefined>): URL {
	const url = new URL(`${GMGN_BASE}${subPath.startsWith("/") ? subPath : `/${subPath}`}`);
	for (const [k, v] of Object.entries(query)) {
		if (v === undefined || v === null) continue;
		if (Array.isArray(v)) {
			for (const item of v) url.searchParams.append(k, String(item));
		} else {
			url.searchParams.set(k, String(v));
		}
	}
	return url;
}

function canonicalMessage(
	subPath: string,
	query: Record<string, GmgnQueryValue | undefined>,
	bodyStr: string,
	timestamp: number,
): string {
	const sortedQs = Object.keys(query)
		.filter((k) => query[k] !== undefined && query[k] !== null)
		.sort()
		.flatMap((k) => {
			const v = query[k]!;
			if (Array.isArray(v)) {
				return [...v].sort().map((item) => `${k}=${item}`);
			}
			return [`${k}=${v}`];
		})
		.join("&");
	return `${subPath}:${sortedQs}:${bodyStr}:${timestamp}`;
}

type GmgnEnvelope = {
	code: number | string;
	data?: unknown;
	message?: string;
	error?: string;
};

export type GmgnRequest = {
	method: "GET" | "POST";
	subPath: string;
	query?: Record<string, GmgnQueryValue | undefined>;
	body?: unknown;
	critical?: boolean;
};

/** Throws if GMGN_API_KEY is missing — call `loadGmgnConfig()` first if you want a soft path. */
export async function gmgnRequest(req: GmgnRequest): Promise<unknown> {
	const cfg = loadGmgnConfig();
	if (!cfg.configured) throw new Error(cfg.reason);
	const timestamp = Math.floor(Date.now() / 1000);
	const client_id = randomUUID();
	const query: Record<string, GmgnQueryValue | undefined> = { ...(req.query ?? {}), timestamp, client_id };
	const bodyStr = req.body !== undefined && req.body !== null ? JSON.stringify(req.body) : "";
	const url = buildUrl(req.subPath, query);
	const headers: Record<string, string> = {
		"X-APIKEY": cfg.apiKey,
		"Content-Type": "application/json",
	};
	if (req.critical) {
		if (!cfg.privateKeyPem) {
			throw new Error(
				"GMGN_PRIVATE_KEY required for critical endpoint — see .env.example for setup.",
			);
		}
		const msg = canonicalMessage(req.subPath, query, bodyStr, timestamp);
		headers["X-Signature"] = signMessage(msg, cfg.privateKeyPem);
	}
	const res = await fetch(url.toString(), {
		method: req.method,
		headers,
		body: req.method === "POST" ? bodyStr || "{}" : undefined,
	});
	const text = await res.text();
	let json: GmgnEnvelope;
	try {
		json = JSON.parse(text) as GmgnEnvelope;
	} catch {
		throw new Error(
			`gmgn ${req.method} ${req.subPath} HTTP ${res.status}: non-JSON response (${text.slice(0, 300)})`,
		);
	}
	if (json.code !== 0 && json.code !== "0") {
		const parts = [
			`gmgn ${req.method} ${req.subPath} → HTTP ${res.status}`,
			`code=${json.code}`,
			json.error ? `error=${json.error}` : "",
			json.message ? `message=${json.message}` : "",
		].filter(Boolean);
		throw new Error(parts.join(" "));
	}
	return json.data ?? null;
}
