/**
 * GMGN OpenAPI Agent API client — agent-callable actions matching the
 * official GMGN AI Agent product (https://docs.gmgn.ai/index/gmgn-agent-api
 * and the reference client at github.com/GMGNAI/gmgn-skills).
 *
 * Host:    https://openapi.gmgn.ai
 * Auth:    X-APIKEY header + `timestamp` (unix seconds, ±5s) and
 *          `client_id` (UUID, replay window 7s) on every query string.
 * Signing: `/v1/trade/*` + `/v1/cooking/create_token` (critical endpoints)
 *          additionally require an `X-Signature` header — Ed25519 (or
 *          RSA-PSS SHA-256, salt 32) over the canonical message
 *          `${subPath}:${sortedQs}:${body}:${timestamp}`.
 *
 * IMPORTANT — GMGN trades run on **GMGN-hosted custody**.
 * The `from_address` for `/v1/trade/swap` must be a wallet *bound to the
 * API key on GMGN's side*, NOT the user's Phantom wallet. This plugin
 * does NOT move funds out of the user's Phantom wallet — for that, the
 * agent should use the separate `PHANTOM_SOLANA_*` / `PHANTOM_EVM_*`
 * actions and a router like Jupiter/Raydium directly.
 *
 * Required env:
 *   GMGN_API_KEY     — issued at https://gmgn.ai/ai after uploading the
 *                      Ed25519 (or RSA) PUBLIC key generated locally
 *   GMGN_PRIVATE_KEY — PEM private key (PKCS#8 Ed25519 or RSA). Required
 *                      for trade/order endpoints. Single-line `.env` users
 *                      can escape newlines as `\n` — they are restored
 *                      before parsing.
 *
 * Specialized actions cover the most common Skills (token info, security,
 * pool info, kline, top holders, wallet holdings/stats/activity, trending,
 * quote+swap+query_order). For everything else (KOL, smart money, signal
 * groups, multi-swap, strategy orders, trenches, cooking) the agent can
 * use `GMGN_API_CALL` with an explicit path.
 */

import type {
	Action,
	ActionResult,
	Handler,
	HandlerCallback,
	Plugin,
} from "@elizaos/core";
import { gmgnRequest, type GmgnQueryValue } from "../../core/gmgn-client";

// ── Helpers: shape param extraction (matches phantom-wallet-tools style) ─

function paramsBag(opts: Record<string, unknown> | undefined): Record<string, unknown> {
	if (!opts) return {};
	const p = (opts as { parameters?: unknown }).parameters;
	if (p && typeof p === "object" && !Array.isArray(p)) return p as Record<string, unknown>;
	return {};
}

function pickString(
	opts: Record<string, unknown> | undefined,
	keys: readonly string[],
): string | undefined {
	if (!opts) return undefined;
	const bag = paramsBag(opts);
	for (const k of keys) {
		const v = bag[k];
		if (typeof v === "string" && v.length > 0) return v;
	}
	for (const k of keys) {
		const v = opts[k];
		if (typeof v === "string" && v.length > 0) return v;
	}
	return undefined;
}

function pickNumber(
	opts: Record<string, unknown> | undefined,
	keys: readonly string[],
): number | undefined {
	if (!opts) return undefined;
	const bag = paramsBag(opts);
	for (const k of keys) {
		const v = bag[k];
		if (typeof v === "number" && Number.isFinite(v)) return v;
		if (typeof v === "string" && v.trim().length > 0) {
			const n = Number(v);
			if (Number.isFinite(n)) return n;
		}
	}
	for (const k of keys) {
		const v = opts[k];
		if (typeof v === "number" && Number.isFinite(v)) return v;
		if (typeof v === "string" && v.trim().length > 0) {
			const n = Number(v);
			if (Number.isFinite(n)) return n;
		}
	}
	return undefined;
}

function pickBool(opts: Record<string, unknown> | undefined, keys: readonly string[]): boolean {
	if (!opts) return false;
	const bag = paramsBag(opts);
	for (const k of keys) {
		const v = bag[k];
		if (typeof v === "boolean") return v;
		if (typeof v === "string") {
			const s = v.trim().toLowerCase();
			if (s === "true" || s === "1" || s === "yes") return true;
		}
	}
	for (const k of keys) {
		const v = opts[k];
		if (typeof v === "boolean") return v;
		if (typeof v === "string") {
			const s = v.trim().toLowerCase();
			if (s === "true" || s === "1" || s === "yes") return true;
		}
	}
	return false;
}

function pickObject(
	opts: Record<string, unknown> | undefined,
	key: string,
): Record<string, unknown> | undefined {
	if (!opts) return undefined;
	const bag = paramsBag(opts);
	const v = bag[key] ?? opts[key];
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

async function emit(
	callback: HandlerCallback | undefined,
	text: string,
	actionName: string,
): Promise<void> {
	if (!callback) return;
	try {
		await callback({ text, source: "gmgn-tools" } as never, actionName);
	} catch {
		/* ignore */
	}
}

function fail(reason: string): ActionResult {
	return { success: false, text: reason };
}

function ok(text: string): ActionResult {
	return { success: true, text };
}

type QueryValue = GmgnQueryValue;

function normal(
	method: "GET" | "POST",
	subPath: string,
	query: Record<string, QueryValue | undefined>,
	body: unknown | null = null,
): Promise<unknown> {
	return gmgnRequest({ method, subPath, query, body: body ?? undefined, critical: false });
}
function critical(
	method: "GET" | "POST",
	subPath: string,
	query: Record<string, QueryValue | undefined>,
	body: unknown | null = null,
): Promise<unknown> {
	return gmgnRequest({ method, subPath, query, body: body ?? undefined, critical: true });
}

// ── Action handlers ─────────────────────────────────────────────────────

const alwaysValid: Action["validate"] = async () => true;

function chainParam(opts: Record<string, unknown> | undefined): string {
	return (pickString(opts, ["chain"]) ?? "sol").toLowerCase();
}

function reportError(name: string, callback: HandlerCallback | undefined): (e: unknown) => Promise<ActionResult> {
	return async (e) => {
		const msg = e instanceof Error ? e.message : String(e);
		await emit(callback, msg, name);
		return fail(msg);
	};
}

async function returnData(name: string, callback: HandlerCallback | undefined, data: unknown): Promise<ActionResult> {
	const text = JSON.stringify(data, null, 2);
	await emit(callback, text, name);
	return ok(text);
}

// Token

const gmgnTokenInfoHandler: Handler = async (_r, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const address = pickString(opts, ["address", "token", "tokenAddress", "mint", "ca"]);
	if (!address) return fail("Missing token address (params: address, chain?)");
	try {
		const data = await normal("GET", "/v1/token/info", { chain: chainParam(opts), address });
		return returnData("GMGN_TOKEN_INFO", callback, data);
	} catch (e) {
		return reportError("GMGN_TOKEN_INFO", callback)(e);
	}
};

const gmgnTokenSecurityHandler: Handler = async (_r, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const address = pickString(opts, ["address", "token", "tokenAddress", "mint", "ca"]);
	if (!address) return fail("Missing token address (params: address, chain?)");
	try {
		const data = await normal("GET", "/v1/token/security", { chain: chainParam(opts), address });
		return returnData("GMGN_TOKEN_SECURITY", callback, data);
	} catch (e) {
		return reportError("GMGN_TOKEN_SECURITY", callback)(e);
	}
};

const gmgnTokenPoolInfoHandler: Handler = async (_r, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const address = pickString(opts, ["address", "token", "tokenAddress", "mint", "ca"]);
	if (!address) return fail("Missing token address (params: address, chain?)");
	try {
		const data = await normal("GET", "/v1/token/pool_info", { chain: chainParam(opts), address });
		return returnData("GMGN_TOKEN_POOL_INFO", callback, data);
	} catch (e) {
		return reportError("GMGN_TOKEN_POOL_INFO", callback)(e);
	}
};

const gmgnTopHoldersHandler: Handler = async (_r, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const address = pickString(opts, ["address", "token", "tokenAddress", "mint", "ca"]);
	const limit = pickNumber(opts, ["limit", "count"]);
	if (!address) return fail("Missing token address (params: address, chain?, limit?)");
	try {
		const data = await normal("GET", "/v1/market/token_top_holders", {
			chain: chainParam(opts),
			address,
			...(limit !== undefined ? { limit } : {}),
		});
		return returnData("GMGN_TOKEN_HOLDERS", callback, data);
	} catch (e) {
		return reportError("GMGN_TOKEN_HOLDERS", callback)(e);
	}
};

const gmgnTopTradersHandler: Handler = async (_r, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const address = pickString(opts, ["address", "token", "tokenAddress", "mint", "ca"]);
	const limit = pickNumber(opts, ["limit", "count"]);
	if (!address) return fail("Missing token address (params: address, chain?, limit?)");
	try {
		const data = await normal("GET", "/v1/market/token_top_traders", {
			chain: chainParam(opts),
			address,
			...(limit !== undefined ? { limit } : {}),
		});
		return returnData("GMGN_TOKEN_TRADERS", callback, data);
	} catch (e) {
		return reportError("GMGN_TOKEN_TRADERS", callback)(e);
	}
};

// Market

const gmgnKlineHandler: Handler = async (_r, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const address = pickString(opts, ["address", "token", "tokenAddress", "mint", "ca"]);
	const resolution = pickString(opts, ["resolution", "interval", "tf", "timeframe"]) ?? "1m";
	const from = pickNumber(opts, ["from", "fromTs", "from_ts"]);
	const to = pickNumber(opts, ["to", "toTs", "to_ts"]);
	if (!address) return fail("Missing token address (params: address, chain?, resolution?, from?, to?)");
	try {
		const data = await normal("GET", "/v1/market/token_kline", {
			chain: chainParam(opts),
			address,
			resolution,
			...(from !== undefined ? { from } : {}),
			...(to !== undefined ? { to } : {}),
		});
		return returnData("GMGN_KLINE", callback, data);
	} catch (e) {
		return reportError("GMGN_KLINE", callback)(e);
	}
};

const gmgnTrendingHandler: Handler = async (_r, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const interval = pickString(opts, ["interval", "window", "tf"]) ?? "1h";
	const limit = pickNumber(opts, ["limit", "count"]);
	const orderBy = pickString(opts, ["order_by", "orderby", "sort"]);
	const direction = pickString(opts, ["direction", "order"]);
	try {
		const data = await normal("GET", "/v1/market/rank", {
			chain: chainParam(opts),
			interval,
			...(limit !== undefined ? { limit } : {}),
			...(orderBy ? { order_by: orderBy } : {}),
			...(direction ? { direction } : {}),
		});
		return returnData("GMGN_TRENDING", callback, data);
	} catch (e) {
		return reportError("GMGN_TRENDING", callback)(e);
	}
};

// Portfolio / Wallet

const gmgnWalletHoldingsHandler: Handler = async (_r, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const wallet = pickString(opts, ["wallet", "walletAddress", "wallet_address", "address"]);
	const limit = pickNumber(opts, ["limit", "count"]);
	if (!wallet) return fail("Missing wallet (params: wallet, chain?, limit?)");
	try {
		const data = await normal("GET", "/v1/user/wallet_holdings", {
			chain: chainParam(opts),
			wallet_address: wallet,
			...(limit !== undefined ? { limit } : {}),
		});
		return returnData("GMGN_WALLET_HOLDINGS", callback, data);
	} catch (e) {
		return reportError("GMGN_WALLET_HOLDINGS", callback)(e);
	}
};

const gmgnWalletStatsHandler: Handler = async (_r, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const walletsRaw = pickString(opts, ["wallets", "wallet_address"]);
	const wallet = pickString(opts, ["wallet", "walletAddress", "address"]);
	const period = pickString(opts, ["period"]) ?? "7d";
	const addresses = walletsRaw ? walletsRaw.split(",").map((s) => s.trim()).filter(Boolean) : wallet ? [wallet] : [];
	if (addresses.length === 0) return fail("Missing wallet(s) (params: wallet or wallets=csv, chain?, period?)");
	try {
		const data = await normal("GET", "/v1/user/wallet_stats", {
			chain: chainParam(opts),
			wallet_address: addresses,
			period,
		});
		return returnData("GMGN_WALLET_STATS", callback, data);
	} catch (e) {
		return reportError("GMGN_WALLET_STATS", callback)(e);
	}
};

const gmgnWalletActivityHandler: Handler = async (_r, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const wallet = pickString(opts, ["wallet", "walletAddress", "wallet_address", "address"]);
	const token = pickString(opts, ["token", "token_address"]);
	const limit = pickNumber(opts, ["limit"]);
	if (!wallet) return fail("Missing wallet (params: wallet, chain?, token?, limit?)");
	try {
		const data = await normal("GET", "/v1/user/wallet_activity", {
			chain: chainParam(opts),
			wallet_address: wallet,
			...(token ? { token_address: token } : {}),
			...(limit !== undefined ? { limit } : {}),
		});
		return returnData("GMGN_WALLET_ACTIVITY", callback, data);
	} catch (e) {
		return reportError("GMGN_WALLET_ACTIVITY", callback)(e);
	}
};

// Trading (critical auth — requires GMGN_PRIVATE_KEY + GMGN-bound wallet)

const gmgnQuoteHandler: Handler = async (_r, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const from = pickString(opts, ["from", "from_address", "fromAddress"]);
	const inputToken = pickString(opts, ["input_token", "inputToken", "tokenIn"]);
	const outputToken = pickString(opts, ["output_token", "outputToken", "tokenOut"]);
	const inputAmount = pickString(opts, ["input_amount", "inputAmount", "amount"]);
	const slippage = pickNumber(opts, ["slippage"]) ?? 0.01;
	if (!from || !inputToken || !outputToken || !inputAmount) {
		return fail(
			"Missing params: from (GMGN-bound wallet), input_token, output_token, input_amount (raw units), slippage? (fraction, default 0.01 = 1%)",
		);
	}
	try {
		const data = await critical("GET", "/v1/trade/quote", {
			chain: chainParam(opts),
			from_address: from,
			input_token: inputToken,
			output_token: outputToken,
			input_amount: inputAmount,
			slippage,
		});
		return returnData("GMGN_QUOTE", callback, data);
	} catch (e) {
		return reportError("GMGN_QUOTE", callback)(e);
	}
};

const gmgnSwapHandler: Handler = async (_r, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const from = pickString(opts, ["from", "from_address", "fromAddress"]);
	const inputToken = pickString(opts, ["input_token", "inputToken", "tokenIn"]);
	const outputToken = pickString(opts, ["output_token", "outputToken", "tokenOut"]);
	const inputAmount = pickString(opts, ["input_amount", "inputAmount", "amount"]);
	const inputAmountBps = pickString(opts, ["input_amount_bps", "percentBps"]);
	const slippage = pickNumber(opts, ["slippage"]);
	const autoSlippage = pickBool(opts, ["auto_slippage", "autoSlippage"]);
	const antiMev = pickBool(opts, ["is_anti_mev", "antiMev"]);
	const priorityFee = pickString(opts, ["priority_fee", "priorityFee"]);
	const tipFee = pickString(opts, ["tip_fee", "tipFee"]);
	if (!from || !inputToken || !outputToken || (!inputAmount && !inputAmountBps)) {
		return fail(
			"Missing params: from (must be a wallet BOUND to GMGN_API_KEY in GMGN's hosted-custody dashboard, NOT your Phantom wallet), input_token, output_token, and one of input_amount (raw units) or input_amount_bps (percent in basis points, e.g. 5000 = 50%). Optional: slippage (fraction), auto_slippage, is_anti_mev, priority_fee, tip_fee. Chain via chain= (sol|bsc|base|eth).",
		);
	}
	const body: Record<string, unknown> = {
		chain: chainParam(opts),
		from_address: from,
		input_token: inputToken,
		output_token: outputToken,
		input_amount: inputAmount ?? "0",
	};
	if (inputAmountBps) body.input_amount_bps = inputAmountBps;
	if (slippage !== undefined) body.slippage = slippage;
	if (autoSlippage) body.auto_slippage = true;
	if (antiMev) body.is_anti_mev = true;
	if (priorityFee) body.priority_fee = priorityFee;
	if (tipFee) body.tip_fee = tipFee;
	try {
		const data = await critical("POST", "/v1/trade/swap", {}, body);
		return returnData("GMGN_SWAP", callback, data);
	} catch (e) {
		return reportError("GMGN_SWAP", callback)(e);
	}
};

const gmgnQueryOrderHandler: Handler = async (_r, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const orderId = pickString(opts, ["order_id", "orderId", "id"]);
	if (!orderId) return fail("Missing order_id (params: order_id, chain?)");
	try {
		const data = await critical("GET", "/v1/trade/query_order", {
			order_id: orderId,
			chain: chainParam(opts),
		});
		return returnData("GMGN_QUERY_ORDER", callback, data);
	} catch (e) {
		return reportError("GMGN_QUERY_ORDER", callback)(e);
	}
};

// Generic escape hatch — for any endpoint not specialized above.

const gmgnApiCallHandler: Handler = async (_r, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const path = pickString(opts, ["path", "subPath", "endpoint"]);
	const method = (pickString(opts, ["method"]) ?? "GET").toUpperCase();
	const isCritical = pickBool(opts, ["critical", "signed", "isCritical"]) || path?.startsWith("/v1/trade/") || path === "/v1/cooking/create_token";
	if (!path) {
		return fail(
			"Missing path (params: path e.g. '/v1/market/rank', method? GET|POST, query? object, body? object, critical? bool — auto-true for /v1/trade/*)",
		);
	}
	const query = pickObject(opts, "query") ?? {};
	const body = pickObject(opts, "body");
	const queryClean: Record<string, QueryValue | undefined> = {};
	for (const [k, v] of Object.entries(query)) {
		if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") queryClean[k] = v;
		else if (Array.isArray(v) && v.every((x) => typeof x === "string")) queryClean[k] = v as string[];
	}
	try {
		const data = await gmgnRequest({
			method: method === "POST" ? "POST" : "GET",
			subPath: path,
			query: queryClean,
			body: body ?? undefined,
			critical: Boolean(isCritical),
		});
		return returnData("GMGN_API_CALL", callback, data);
	} catch (e) {
		return reportError("GMGN_API_CALL", callback)(e);
	}
};

// ── Action exports ──────────────────────────────────────────────────────

const gmgnTokenInfo: Action = {
	name: "GMGN_TOKEN_INFO",
	similes: ["TOKEN_INFO_GMGN", "GMGN_TOKEN_PROFILE"],
	description:
		"GMGN OpenAPI: basic token profile (price, market cap, etc.). Params: address (mint/contract), chain? (sol|bsc|base|eth, default sol).",
	validate: alwaysValid,
	handler: gmgnTokenInfoHandler,
};
const gmgnTokenSecurity: Action = {
	name: "GMGN_TOKEN_SECURITY",
	similes: ["GMGN_TOKEN_SAFETY", "TOKEN_SECURITY"],
	description:
		"GMGN OpenAPI: contract security checks (mint/freeze authority, top10 concentration, honeypot, etc.). Params: address, chain?.",
	validate: alwaysValid,
	handler: gmgnTokenSecurityHandler,
};
const gmgnTokenPoolInfo: Action = {
	name: "GMGN_TOKEN_POOL_INFO",
	similes: ["GMGN_POOL_INFO", "GMGN_LIQUIDITY"],
	description: "GMGN OpenAPI: liquidity pool state for a token. Params: address, chain?.",
	validate: alwaysValid,
	handler: gmgnTokenPoolInfoHandler,
};
const gmgnTokenHolders: Action = {
	name: "GMGN_TOKEN_HOLDERS",
	similes: ["GMGN_TOP_HOLDERS"],
	description: "GMGN OpenAPI: top holders for a token. Params: address, chain?, limit?.",
	validate: alwaysValid,
	handler: gmgnTopHoldersHandler,
};
const gmgnTokenTraders: Action = {
	name: "GMGN_TOKEN_TRADERS",
	similes: ["GMGN_TOP_TRADERS"],
	description: "GMGN OpenAPI: top traders for a token (sniper/insider profiling). Params: address, chain?, limit?.",
	validate: alwaysValid,
	handler: gmgnTopTradersHandler,
};
const gmgnKline: Action = {
	name: "GMGN_KLINE",
	similes: ["GMGN_TOKEN_CANDLES", "GMGN_MARKET_CANDLES"],
	description:
		"GMGN OpenAPI: candlestick / kline data. Params: address, chain?, resolution? (1m|5m|15m|1h|4h|1d, default 1m), from? (unix sec), to? (unix sec).",
	validate: alwaysValid,
	handler: gmgnKlineHandler,
};
const gmgnTrending: Action = {
	name: "GMGN_TRENDING",
	similes: ["GMGN_HOT_TOKENS", "GMGN_RANK"],
	description:
		"GMGN OpenAPI: trending tokens. Params: chain?, interval? (1m|5m|1h|6h|24h, default 1h), limit?, order_by?, direction?.",
	validate: alwaysValid,
	handler: gmgnTrendingHandler,
};
const gmgnWalletHoldings: Action = {
	name: "GMGN_WALLET_HOLDINGS",
	similes: ["GMGN_PORTFOLIO"],
	description: "GMGN OpenAPI: wallet token holdings + PnL. Params: wallet, chain?, limit?.",
	validate: alwaysValid,
	handler: gmgnWalletHoldingsHandler,
};
const gmgnWalletStats: Action = {
	name: "GMGN_WALLET_STATS",
	similes: ["GMGN_WALLET_PNL"],
	description: "GMGN OpenAPI: trading statistics for one or many wallets. Params: wallet OR wallets=csv, chain?, period? (7d|30d, default 7d).",
	validate: alwaysValid,
	handler: gmgnWalletStatsHandler,
};
const gmgnWalletActivity: Action = {
	name: "GMGN_WALLET_ACTIVITY",
	similes: ["GMGN_WALLET_TRADES"],
	description: "GMGN OpenAPI: recent trades / activity for a wallet. Params: wallet, chain?, token? (filter by mint), limit?.",
	validate: alwaysValid,
	handler: gmgnWalletActivityHandler,
};
const gmgnQuote: Action = {
	name: "GMGN_QUOTE",
	similes: ["GMGN_TRADE_QUOTE"],
	description:
		"GMGN OpenAPI: get an indicative swap quote (critical auth). Requires GMGN_PRIVATE_KEY. The `from` wallet must be bound to the API key on GMGN's side. Params: from, input_token, output_token, input_amount (raw units), slippage? (fraction, default 0.01), chain?.",
	validate: alwaysValid,
	handler: gmgnQuoteHandler,
};
const gmgnSwap: Action = {
	name: "GMGN_SWAP",
	similes: ["GMGN_TRADE_SWAP", "GMGN_BUY", "GMGN_SELL"],
	description:
		"GMGN OpenAPI: submit a swap from a GMGN-hosted (API-key-bound) wallet. NOTE: this does NOT move funds out of the user's Phantom wallet — `from` must be a wallet pre-bound to GMGN_API_KEY in the GMGN dashboard. Requires GMGN_PRIVATE_KEY. Params: from, input_token, output_token, input_amount OR input_amount_bps (basis points), slippage?, auto_slippage?, is_anti_mev?, priority_fee?, tip_fee?, chain?.",
	validate: alwaysValid,
	handler: gmgnSwapHandler,
};
const gmgnQueryOrder: Action = {
	name: "GMGN_QUERY_ORDER",
	similes: ["GMGN_ORDER_STATUS", "GMGN_TX_STATUS"],
	description: "GMGN OpenAPI: query a swap order's status by id (critical auth). Params: order_id, chain?.",
	validate: alwaysValid,
	handler: gmgnQueryOrderHandler,
};
const gmgnApiCall: Action = {
	name: "GMGN_API_CALL",
	similes: ["GMGN_CALL", "GMGN_HTTP"],
	description:
		"GMGN OpenAPI escape hatch: call any openapi.gmgn.ai endpoint with proper auth headers + timestamp/client_id injection. Params: path (e.g. '/v1/user/kol'), method? (GET|POST), query? object, body? object, critical? bool (auto-true for /v1/trade/*; toggles X-Signature using GMGN_PRIVATE_KEY).",
	validate: alwaysValid,
	handler: gmgnApiCallHandler,
};

export const gmgnToolsPlugin: Plugin = {
	name: "@detour/plugin-gmgn-tools",
	description:
		"GMGN OpenAPI Agent — token info / security / pool / kline / holders / traders / trending plus wallet holdings/stats/activity. Trading (quote / swap / query_order) and other critical endpoints sign each request with GMGN_PRIVATE_KEY. Trading happens against GMGN-hosted custody (the `from` wallet must be pre-bound to the API key) — separate from the user's Phantom wallet.",
	actions: [
		gmgnTokenInfo,
		gmgnTokenSecurity,
		gmgnTokenPoolInfo,
		gmgnTokenHolders,
		gmgnTokenTraders,
		gmgnKline,
		gmgnTrending,
		gmgnWalletHoldings,
		gmgnWalletStats,
		gmgnWalletActivity,
		gmgnQuote,
		gmgnSwap,
		gmgnQueryOrder,
		gmgnApiCall,
	],
};
