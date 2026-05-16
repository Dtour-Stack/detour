---
name: gmgn
description: Use when the user asks Detour to query on-chain token data, market candles, holders, trending tokens, or wallet portfolios via GMGN, or to execute a swap from a GMGN-hosted wallet (sol / bsc / base / eth). Covers the GMGN_* and related PHANTOM_* actions exposed by Detour's @detour/plugin-gmgn-tools and @detour/plugin-phantom-wallet-tools.
metadata: {"otto":{"emoji":"📈","requires":{"env":["GMGN_API_KEY"]}}}
---

# GMGN

GMGN is Detour's on-chain data + trading bridge. Two key facts before you act:

1. **Two different wallets, two different custody models.**
   - GMGN trade endpoints (`GMGN_SWAP`, `GMGN_QUOTE`, `GMGN_QUERY_ORDER`) move funds in a wallet **bound to the user's GMGN API key inside GMGN's own dashboard**. This is hosted custody — not the user's Phantom wallet.
   - The user's Phantom wallet (`PHANTOM_*` actions) is user-custody. Use it for non-GMGN routers (Jupiter, Raydium, generic EVM txs) and for proof-of-ownership signatures.
   - Never use `GMGN_SWAP` to "send funds from my Phantom wallet" — those are different accounts.

2. **Required env to do anything useful.**
   - `GMGN_API_KEY` — issued at https://gmgn.ai/ai after uploading an Ed25519 public key. Required for every GMGN_* action.
   - `GMGN_PRIVATE_KEY` — PEM (PKCS#8) private half. Only required for trade endpoints (`GMGN_QUOTE`, `GMGN_SWAP`, `GMGN_QUERY_ORDER`, anything passed through `GMGN_API_CALL` with `critical: true` or path starting `/v1/trade/`).
   - If either is missing, the action fails fast with a clear setup message — relay it verbatim to the user.

## Inputs to collect

- Chain: one of `sol`, `bsc`, `base`, `eth`. Most actions default to `sol`.
- Token contract / mint address (base58 for sol, `0x…` for EVM).
- Wallet address — for portfolio queries, any address. For `GMGN_SWAP from=…`, must be GMGN-bound.
- Amounts: pass raw units (lamports for SOL, wei for EVM, smallest unit for SPL/ERC20) as a string. Slippage is a fraction (`0.01` = 1%) unless the action note says otherwise.

## Choosing the right action

| Goal                                                              | Action                                        |
| ----------------------------------------------------------------- | --------------------------------------------- |
| Token basics (price, mc, symbol)                                  | `GMGN_TOKEN_INFO`                             |
| Safety / honeypot / mint authority check                          | `GMGN_TOKEN_SECURITY`                         |
| Liquidity pool / TVL                                              | `GMGN_TOKEN_POOL_INFO`                        |
| Top holders                                                       | `GMGN_TOKEN_HOLDERS`                          |
| Top traders (sniper / insider profile)                            | `GMGN_TOKEN_TRADERS`                          |
| Candlestick / kline                                               | `GMGN_KLINE`                                  |
| Trending list                                                     | `GMGN_TRENDING`                               |
| Wallet's tokens + PnL                                             | `GMGN_WALLET_HOLDINGS`                        |
| Aggregate wallet stats (1+ wallets)                               | `GMGN_WALLET_STATS`                           |
| Recent trades for a wallet                                        | `GMGN_WALLET_ACTIVITY`                        |
| Indicative quote before a trade                                   | `GMGN_QUOTE`                                  |
| Submit a buy/sell from a GMGN-bound wallet                        | `GMGN_SWAP`                                   |
| Check status of a submitted order                                 | `GMGN_QUERY_ORDER`                            |
| Anything not in the table (KOL, smart money, strategy, trenches…) | `GMGN_API_CALL` with explicit `path`          |
| Sign a Solana tx with user's Phantom (Jupiter/etc.)               | `PHANTOM_SOLANA_SIGN_AND_SEND`                |
| Prove ownership of the user's Solana address                      | `PHANTOM_SOLANA_SIGN_MESSAGE`                 |
| Send an EVM tx from user's Phantom                                | `PHANTOM_EVM_SEND_TRANSACTION`                |
| What's connected right now                                        | `PHANTOM_GET_STATUS`                          |
| User asks "how's my wallet doing?" / portfolio digest             | `PHANTOM_WALLET_REPORT`                       |

## Worked examples

### Should I buy this token? (Solana mint)

1. `GMGN_TOKEN_INFO { address: "<mint>" }` — basic profile.
2. `GMGN_TOKEN_SECURITY { address: "<mint>" }` — honeypot / mint / freeze authority.
3. `GMGN_TOKEN_POOL_INFO { address: "<mint>" }` — liquidity depth.
4. `GMGN_KLINE { address: "<mint>", resolution: "5m" }` — recent price action.
5. Surface red flags (mint authority not renounced, top10 > 50%, low liquidity, sharp recent dumps) before any trade suggestion.

### Buy 0.1 SOL of `<mint>` via GMGN hosted custody

1. `GMGN_QUOTE { chain: "sol", from: "<gmgn-bound-wallet>", input_token: "So11111111111111111111111111111111111111112", output_token: "<mint>", input_amount: "100000000", slippage: 0.01 }`
2. Show the quote to the user, confirm.
3. `GMGN_SWAP { chain: "sol", from: "<gmgn-bound-wallet>", input_token: "So111...112", output_token: "<mint>", input_amount: "100000000", slippage: 0.01 }`
4. Capture `order_id` from the response.
5. `GMGN_QUERY_ORDER { order_id: "<id>", chain: "sol" }` to poll until settled.

### Sell 50% of holdings of `<mint>`

Use `input_amount_bps: "5000"` (basis points) instead of `input_amount`, with `input_token: "<mint>"` and `output_token: "<base-token>"`. Base tokens: SOL → `So11111111111111111111111111111111111111112`, BSC → BNB native, Base → ETH native. Confirm with the user which base token they want proceeds in.

### Daily portfolio check / "how am I doing?"

```json
{ "action": "PHANTOM_WALLET_REPORT", "chain": "sol", "period": "7d" }
```

Auto-resolves the user's connected Phantom Solana address and pulls holdings + stats + activity in one call. Summarize back as: total value, total P&L ($ and %), win rate, top 3 positions with their unrealized P&L, and any notable recent trade (especially large losses or big wins). Track week-over-week deltas yourself across conversations — GMGN's 7d and 30d periods are the canonical comparison windows.

**Metrics to surface (use these exact terms — they're load-bearing for the user):**

- **Total value** (USD) — sum of `usd_value` across all open positions
- **Total P&L** = realized + unrealized (color: green positive, red negative)
- **Win rate** — `winrate` from stats; > 60% strong, < 40% weak
- **PnL ratio** — `pnl` multiplier; 2.0x = doubled money, 0.5x = halved
- **Top positions** — sort by `usd_value`, surface `unrealized_profit` and `profit_change` per
- **Recent activity** — last 20 events; flag full opens (`is_open_or_close=1`) over $1k

If the response includes `__error` keys on any of holdings/stats/activity, mention which section failed but proceed with what came back. Don't refuse to summarize a partial report.

### Check a wallet's recent flips

`GMGN_WALLET_ACTIVITY { wallet: "<addr>", chain: "sol", limit: 50 }`
`GMGN_WALLET_STATS { wallet: "<addr>", chain: "sol", period: "7d" }`

### Use the escape hatch for KOL data

```json
{
  "action": "GMGN_API_CALL",
  "path": "/v1/user/kol",
  "method": "GET",
  "query": { "chain": "sol", "limit": 20 }
}
```

The plugin auto-injects `X-APIKEY`, `timestamp`, `client_id`. Set `critical: true` if calling a `/v1/trade/*` path (auto-detected) or `/v1/cooking/create_token`.

## Guardrails

- Always check `GMGN_TOKEN_SECURITY` before suggesting a swap into an unfamiliar token.
- Echo back the parsed swap (chain, from, amounts, slippage) to the user and wait for explicit confirmation before calling `GMGN_SWAP`. Trading is irreversible.
- If the user says "buy X with my Phantom wallet" — they almost certainly mean their on-chain Phantom funds, NOT a GMGN-bound wallet. Explain the distinction and offer either: (a) fund a GMGN wallet first, or (b) use `PHANTOM_SOLANA_SIGN_AND_SEND` against a non-GMGN router. Don't silently substitute one for the other.
- Slippage units: `GMGN_QUOTE`/`GMGN_SWAP` take a fraction (0.01 = 1%). Other community APIs use bps — don't conflate.
- Rate limit: GMGN bans repeated requests on 429. Back off and surface the reset time from the error string; don't retry-loop.

## References

- Plugin source: `src/bun/plugins/gmgn-tools/index.ts` (action list, env keys, signing logic).
- Phantom plugin: `src/bun/plugins/phantom-wallet-tools/index.ts`.
- Upstream client (for endpoints not yet specialized): https://github.com/GMGNAI/gmgn-skills/blob/main/src/client/OpenApiClient.ts
- Detour memory note: `project-detour-wallets-gmgn` (custody model + auth flow).
