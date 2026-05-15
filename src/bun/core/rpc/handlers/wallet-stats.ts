/**
 * Wallet stats RPC handler — calls GMGN's holdings + stats + activity
 * endpoints in parallel for a given wallet+chain and projects them into
 * a UI-friendly summary. Raw GMGN payloads pass through unchanged so
 * the UI / agent can still read fields the summary hasn't normalized.
 *
 * Field names come from gmgn-skills docs (workflow-wallet-analysis.md):
 *   wallet_holdings: usd_value, unrealized_profit, realized_profit,
 *                    profit_change, history_bought_cost, etc.
 *   wallet_stats:    winrate (0..1), realized_profit, pnl (multiplier),
 *                    buy_count, sell_count, token_num,
 *                    unrealized_profit (best-effort).
 *   wallet_activity: timestamp, type (buy|sell|…), token_address,
 *                    amount_usd / cost_usd, price_change.
 */

import { gmgnRequest, loadGmgnConfig } from "../../gmgn-client";
import type {
	WalletStatsChain,
	WalletStatsPeriod,
	WalletStatsResponse,
	WalletStatsSection,
	WalletStatsSummary,
} from "../../../../shared/rpc/wallet-stats";
import type { RpcDeps } from "../types";

const VALID_CHAINS: ReadonlySet<WalletStatsChain> = new Set(["sol", "bsc", "base", "eth", "monad"]);

function clampChain(input: string | undefined): WalletStatsChain {
	const c = (input ?? "sol").toLowerCase() as WalletStatsChain;
	return VALID_CHAINS.has(c) ? c : "sol";
}

function clampPeriod(input: string | undefined): WalletStatsPeriod {
	return input === "30d" ? "30d" : "7d";
}

function asNumber(v: unknown): number | null {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string" && v.trim()) {
		const n = Number(v);
		if (Number.isFinite(n)) return n;
	}
	return null;
}

function asString(v: unknown): string | null {
	if (typeof v === "string" && v.length > 0) return v;
	if (typeof v === "number" && Number.isFinite(v)) return String(v);
	return null;
}

function pickField<T>(record: Record<string, unknown> | null | undefined, keys: readonly string[], cast: (v: unknown) => T | null): T | null {
	if (!record) return null;
	for (const k of keys) {
		const v = record[k];
		if (v === undefined || v === null) continue;
		const out = cast(v);
		if (out !== null) return out;
	}
	return null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asArray(v: unknown): unknown[] {
	if (Array.isArray(v)) return v;
	const obj = asRecord(v);
	if (!obj) return [];
	for (const key of ["holdings", "list", "data", "items", "result", "activity", "rows"]) {
		const inner = obj[key];
		if (Array.isArray(inner)) return inner;
	}
	return [];
}

/** True when we either know the response was empty/null OR successfully
 *  located rows in a known envelope shape. False when the response has
 *  content but none of the known unwrap keys hit — likely schema drift. */
function arrayParsed(v: unknown): boolean {
	if (v === null || v === undefined) return true;
	if (Array.isArray(v)) return true;
	const obj = asRecord(v);
	if (!obj) return false;
	for (const key of ["holdings", "list", "data", "items", "result", "activity", "rows"]) {
		if (Array.isArray(obj[key])) return true;
	}
	return false;
}

function rawTopLevelKeys(v: unknown): string[] {
	if (Array.isArray(v)) return [`<array length=${v.length}>`];
	const obj = asRecord(v);
	return obj ? Object.keys(obj).slice(0, 20) : [];
}

/** Stats may come back as a single record OR a single-element array when
 *  one wallet is queried. Normalize both. */
function statsRecordFromRaw(v: unknown): Record<string, unknown> | null {
	if (!v) return null;
	if (Array.isArray(v)) {
		for (const item of v) {
			const r = asRecord(item);
			if (r) return r;
		}
		return null;
	}
	const r = asRecord(v);
	if (!r) return null;
	// envelope-style: { list: [...] } or { stats: {...} }
	for (const key of ["list", "stats", "result", "data"]) {
		const inner = r[key];
		if (Array.isArray(inner)) {
			for (const item of inner) {
				const sub = asRecord(item);
				if (sub) return sub;
			}
		} else {
			const sub = asRecord(inner);
			if (sub) return sub;
		}
	}
	return r;
}

function projectHolding(raw: unknown): WalletStatsSummary["topPositions"][number] {
	const r = asRecord(raw);
	const tokenRecord = asRecord(r?.token) ?? asRecord(r?.token_info) ?? r;
	return {
		tokenAddress: pickField(tokenRecord, ["address", "token_address", "ca", "mint"], asString),
		symbol: pickField(tokenRecord, ["symbol", "token_symbol"], asString),
		name: pickField(tokenRecord, ["name", "token_name"], asString),
		usdValue: pickField(r, ["usd_value"], asNumber),
		unrealizedProfitUsd: pickField(r, ["unrealized_profit"], asNumber),
		profitChange: pickField(r, ["profit_change"], asNumber),
		balance: pickField(r, ["balance", "amount", "token_amount"], asString),
	};
}

function projectActivity(raw: unknown): WalletStatsSummary["recentActivity"][number] {
	const r = asRecord(raw);
	const tokenRecord = asRecord(r?.token) ?? asRecord(r?.token_info) ?? r;
	const tsRaw = pickField(r, ["timestamp", "ts", "trade_timestamp", "last_active_timestamp"], asNumber);
	return {
		timestamp: tsRaw,
		type: pickField(r, ["type", "event_type", "side"], asString),
		tokenAddress: pickField(tokenRecord, ["address", "token_address", "ca", "mint"], asString),
		symbol: pickField(tokenRecord, ["symbol", "token_symbol"], asString),
		amountUsd: pickField(r, ["amount_usd", "cost_usd", "usd_value", "volume_usd"], asNumber),
		priceChange: pickField(r, ["price_change"], asNumber),
	};
}

function buildSummary(args: {
	holdings: unknown;
	stats: unknown;
	activity: unknown;
	holdingsLimit: number;
	activityLimit: number;
}): { summary: WalletStatsSummary; parsed: { holdings: boolean; stats: boolean; activity: boolean } } {
	const holdingsArr = asArray(args.holdings);
	const activityArr = asArray(args.activity);
	const statsRecord = statsRecordFromRaw(args.stats);
	const holdingsParsed = arrayParsed(args.holdings);
	const activityParsed = arrayParsed(args.activity);
	const statsParsed = args.stats === null || args.stats === undefined || statsRecord !== null;
	let totalUsdValue = 0;
	let totalUnrealized = 0;
	let totalRealizedFromHoldings = 0;
	for (const item of holdingsArr) {
		const r = asRecord(item);
		if (!r) continue;
		totalUsdValue += asNumber(r.usd_value) ?? 0;
		totalUnrealized += asNumber(r.unrealized_profit) ?? 0;
		totalRealizedFromHoldings += asNumber(r.realized_profit) ?? 0;
	}
	const topPositions = [...holdingsArr]
		.map((row) => ({ row, value: asNumber(asRecord(row)?.usd_value) ?? 0 }))
		.sort((a, b) => b.value - a.value)
		.slice(0, args.holdingsLimit)
		.map((x) => projectHolding(x.row));

	const recentActivity = activityArr
		.slice(0, args.activityLimit)
		.map(projectActivity);

	const winrate = pickField(statsRecord, ["winrate", "win_rate"], asNumber);
	const realizedFromStats = pickField(statsRecord, ["realized_profit", "realized_profit_usd"], asNumber);
	const unrealizedFromStats = pickField(statsRecord, ["unrealized_profit", "unrealized_profit_usd"], asNumber);
	const pnlMultiplier = pickField(statsRecord, ["pnl", "pnl_ratio"], asNumber);
	const buyCount = pickField(statsRecord, ["buy_count", "buy_num"], asNumber);
	const sellCount = pickField(statsRecord, ["sell_count", "sell_num"], asNumber);
	const tokenCount = pickField(statsRecord, ["token_num", "token_count", "total_token_num"], asNumber);

	const realized = realizedFromStats ?? (totalRealizedFromHoldings || null);
	const unrealized = unrealizedFromStats ?? (totalUnrealized || null);
	const totalPnl = realized !== null || unrealized !== null
		? (realized ?? 0) + (unrealized ?? 0)
		: null;

	return {
		summary: {
			totalUsdValue: holdingsArr.length > 0 ? totalUsdValue : null,
			totalPnlUsd: totalPnl,
			totalRealizedUsd: realized,
			totalUnrealizedUsd: unrealized,
			winrate,
			pnlMultiplier,
			buyCount,
			sellCount,
			tokenCount: tokenCount ?? (holdingsArr.length || null),
			topPositions,
			recentActivity,
		},
		parsed: { holdings: holdingsParsed, stats: statsParsed, activity: activityParsed },
	};
}

async function safeRequest(label: string, run: () => Promise<unknown>): Promise<{ data: unknown; error: string | null }> {
	try {
		return { data: await run(), error: null };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[wallet-stats] ${label} failed:`, msg);
		return { data: null, error: msg };
	}
}

export function walletStatsRequests(_deps: RpcDeps) {
	return {
		walletStatsGet: async (params: {
			wallet: string;
			chain?: WalletStatsChain;
			period?: WalletStatsPeriod;
			activityLimit?: number;
			holdingsLimit?: number;
		}): Promise<WalletStatsResponse> => {
			const wallet = (params.wallet ?? "").trim();
			if (!wallet) throw new Error("wallet address is required");
			const cfg = loadGmgnConfig();
			if (!cfg.configured) {
				return { configured: false, reason: cfg.reason };
			}
			const chain = clampChain(params.chain);
			const period = clampPeriod(params.period);
			const holdingsLimit = Math.max(1, Math.min(50, Math.round(params.holdingsLimit ?? 50)));
			const activityLimit = Math.max(1, Math.min(100, Math.round(params.activityLimit ?? 25)));

			const [holdings, stats, activity] = await Promise.all([
				safeRequest("holdings", () =>
					gmgnRequest({
						method: "GET",
						subPath: "/v1/user/wallet_holdings",
						query: { chain, wallet_address: wallet, limit: holdingsLimit, order_by: "usd_value", direction: "desc" },
					}),
				),
				safeRequest("stats", () =>
					gmgnRequest({
						method: "GET",
						subPath: "/v1/user/wallet_stats",
						query: { chain, wallet_address: [wallet], period },
					}),
				),
				safeRequest("activity", () =>
					gmgnRequest({
						method: "GET",
						subPath: "/v1/user/wallet_activity",
						query: { chain, wallet_address: wallet, limit: activityLimit },
					}),
				),
			]);

			const { summary, parsed } = buildSummary({
				holdings: holdings.data,
				stats: stats.data,
				activity: activity.data,
				holdingsLimit: 8,
				activityLimit: 20,
			});

			const section = (
				err: string | null,
				parsedFlag: boolean,
				rawData: unknown,
			): WalletStatsSection => ({
				error: err,
				parsed: err === null && parsedFlag,
				rawKeys: err ? [] : rawTopLevelKeys(rawData),
			});

			return {
				configured: true,
				wallet,
				chain,
				period,
				fetchedAt: new Date().toISOString(),
				summary,
				raw: {
					holdings: holdings.data,
					stats: stats.data,
					activity: activity.data,
				},
				sections: {
					holdings: section(holdings.error, parsed.holdings, holdings.data),
					stats: section(stats.error, parsed.stats, stats.data),
					activity: section(activity.error, parsed.activity, activity.data),
				},
			};
		},
	};
}
