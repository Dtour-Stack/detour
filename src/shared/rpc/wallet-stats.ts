/**
 * Wallet stats RPC — surfaces GMGN's holdings + trading stats + recent
 * activity for any wallet address (Solana or EVM). The UI uses this to
 * render a live portfolio panel in Settings → Phantom wallet.
 *
 * Soft auth: when GMGN_API_KEY is missing, the response returns
 * `{ configured: false, reason }` instead of throwing so the UI can
 * render a "set up GMGN" affordance instead of a red error.
 *
 * The full raw GMGN payloads (holdings list, stats record, activity list)
 * pass through untouched alongside a small structured summary derived
 * from the documented field names (winrate, realized_profit, pnl, etc.).
 * UI consumers should prefer `summary` and fall back to `raw` for fields
 * we haven't normalized yet.
 */

export type WalletStatsChain = "sol" | "bsc" | "base" | "eth" | "monad";
export type WalletStatsPeriod = "7d" | "30d";

export type WalletStatsSummary = {
	/** Total USD value across all open positions. */
	totalUsdValue: number | null;
	/** Sum of realized + unrealized PnL across positions, USD. */
	totalPnlUsd: number | null;
	totalRealizedUsd: number | null;
	totalUnrealizedUsd: number | null;
	/** 0..1 fraction of profitable trades over `period`. */
	winrate: number | null;
	/** `realized_profit / total_cost` multiplier (1.0 = break-even). */
	pnlMultiplier: number | null;
	buyCount: number | null;
	sellCount: number | null;
	tokenCount: number | null;
	/** Top positions by USD value (max 8). */
	topPositions: Array<{
		tokenAddress: string | null;
		symbol: string | null;
		name: string | null;
		usdValue: number | null;
		unrealizedProfitUsd: number | null;
		profitChange: number | null;
		balance: string | null;
	}>;
	recentActivity: Array<{
		timestamp: number | null;
		type: string | null;
		tokenAddress: string | null;
		symbol: string | null;
		amountUsd: number | null;
		priceChange: number | null;
	}>;
};

/** Per-section signal about whether `buildSummary` actually found the
 *  shape it expected. `parsed: false` with `error: null` means "the GMGN
 *  call succeeded but we couldn't find any rows under the keys we know
 *  about" — i.e. the schema may have shifted. UI uses this to render a
 *  "couldn't parse shape, raw payload available" hint instead of an
 *  empty/zero state that's indistinguishable from a wallet with no
 *  positions. */
export type WalletStatsSection = {
	error: string | null;
	parsed: boolean;
	/** Top-level keys of the raw response — useful for diagnosing
	 *  unparsed shapes without dumping the whole payload. */
	rawKeys: string[];
};

export type WalletStatsResponse =
	| { configured: false; reason: string }
	| {
			configured: true;
			wallet: string;
			chain: WalletStatsChain;
			period: WalletStatsPeriod;
			fetchedAt: string;
			summary: WalletStatsSummary;
			raw: {
				holdings: unknown;
				stats: unknown;
				activity: unknown;
			};
			sections: {
				holdings: WalletStatsSection;
				stats: WalletStatsSection;
				activity: WalletStatsSection;
			};
	  };

export type WalletStatsRequests = {
	walletStatsGet: {
		params: {
			wallet: string;
			chain?: WalletStatsChain;
			period?: WalletStatsPeriod;
			activityLimit?: number;
			holdingsLimit?: number;
		};
		response: WalletStatsResponse;
	};
};
