import { useCallback, useEffect, useMemo, useState } from "react";
import { rpc } from "../rpc";
import type {
	WalletStatsChain,
	WalletStatsPeriod,
	WalletStatsResponse,
	WalletStatsSummary,
} from "../../shared/rpc/wallet-stats";

type Props = {
	/** Pre-fill from Phantom connection; user can still override. */
	defaultSolana: string | null;
	defaultEvm: string | null;
};

const CHAINS: { id: WalletStatsChain; label: string; addressKind: "solana" | "evm" }[] = [
	{ id: "sol", label: "Solana", addressKind: "solana" },
	{ id: "eth", label: "Ethereum", addressKind: "evm" },
	{ id: "base", label: "Base", addressKind: "evm" },
	{ id: "bsc", label: "BSC", addressKind: "evm" },
];

function formatUsd(n: number | null): string {
	if (n === null) return "—";
	const abs = Math.abs(n);
	if (abs >= 1_000_000) return `${n < 0 ? "-" : ""}$${(abs / 1_000_000).toFixed(2)}M`;
	if (abs >= 1_000) return `${n < 0 ? "-" : ""}$${(abs / 1_000).toFixed(2)}k`;
	if (abs >= 1) return `${n < 0 ? "-" : ""}$${abs.toFixed(2)}`;
	return `${n < 0 ? "-" : ""}$${abs.toFixed(4)}`;
}

function formatPct(n: number | null): string {
	if (n === null) return "—";
	return `${(n * 100).toFixed(1)}%`;
}

function formatMultiplier(n: number | null): string {
	if (n === null) return "—";
	return `${n.toFixed(2)}x`;
}

function formatCount(n: number | null): string {
	if (n === null) return "—";
	return n.toLocaleString();
}

function shortAddr(addr: string): string {
	return addr.length > 14 ? `${addr.slice(0, 6)}…${addr.slice(-6)}` : addr;
}

function pnlClass(n: number | null): string {
	if (n === null || n === 0) return "";
	return n > 0 ? "pnl-positive" : "pnl-negative";
}

function pnlSign(n: number | null): string {
	if (n === null) return "";
	return n > 0 ? "+" : "";
}

/** Accepts unix seconds (GMGN's format) or unix ms (>10^10) and renders
 *  a relative-time string. Auto-detects scale via the threshold — any
 *  value > 10^10 is treated as ms, otherwise seconds. */
function relTime(ts: number | null): string {
	if (ts === null) return "—";
	const ms = ts > 10_000_000_000 ? ts : ts * 1000;
	const diff = Date.now() - ms;
	if (diff < 0) return "in the future";
	const secs = Math.floor(diff / 1000);
	if (secs < 60) return `${secs}s ago`;
	const mins = Math.floor(secs / 60);
	if (mins < 60) return `${mins}m ago`;
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return `${hrs}h ago`;
	const days = Math.floor(hrs / 24);
	return `${days}d ago`;
}

function StatStrip({ summary }: { summary: WalletStatsSummary }) {
	const items: { label: string; value: string; cls?: string; hint?: string }[] = [
		{
			label: "Win rate",
			value: formatPct(summary.winrate),
			hint: "Profitable trades over the selected period",
		},
		{
			label: "PnL ratio",
			value: formatMultiplier(summary.pnlMultiplier),
			cls: summary.pnlMultiplier !== null
				? summary.pnlMultiplier >= 1
					? "pnl-positive"
					: "pnl-negative"
				: "",
			hint: "Realized profit ÷ total cost — 1.0 = break-even",
		},
		{ label: "Buys", value: formatCount(summary.buyCount) },
		{ label: "Sells", value: formatCount(summary.sellCount) },
		{ label: "Tokens", value: formatCount(summary.tokenCount) },
	];
	return (
		<div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 8 }}>
			{items.map((it) => (
				<div key={it.label} className="card" style={{ padding: 10 }} title={it.hint}>
					<div className="hint" style={{ fontSize: 11 }}>{it.label}</div>
					<div className={it.cls} style={{ fontSize: 20, fontWeight: 600, marginTop: 2 }}>
						{it.value}
					</div>
				</div>
			))}
		</div>
	);
}

function PositionsTable({ rows }: { rows: WalletStatsSummary["topPositions"] }) {
	if (rows.length === 0) {
		return <p className="hint" style={{ margin: 0 }}>No positions to show.</p>;
	}
	return (
		<table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
			<thead>
				<tr style={{ textAlign: "left", borderBottom: "1px solid var(--border, #333)" }}>
					<th style={{ padding: "6px 4px" }}>Token</th>
					<th style={{ padding: "6px 4px", textAlign: "right" }}>Value</th>
					<th style={{ padding: "6px 4px", textAlign: "right" }}>Unrealized P&L</th>
					<th style={{ padding: "6px 4px", textAlign: "right" }}>% change</th>
				</tr>
			</thead>
			<tbody>
				{rows.map((r, i) => (
					<tr key={`${r.tokenAddress ?? r.symbol ?? i}`} style={{ borderBottom: "1px solid var(--border-faint, #222)" }}>
						<td style={{ padding: "6px 4px" }}>
							<div style={{ display: "flex", flexDirection: "column" }}>
								<strong>{r.symbol ?? "—"}</strong>
								{r.name && r.name !== r.symbol ? (
									<span className="hint" style={{ fontSize: 11 }}>{r.name}</span>
								) : null}
								{r.tokenAddress ? (
									<code className="hint" style={{ fontSize: 10 }}>{shortAddr(r.tokenAddress)}</code>
								) : null}
							</div>
						</td>
						<td style={{ padding: "6px 4px", textAlign: "right" }}>{formatUsd(r.usdValue)}</td>
						<td className={pnlClass(r.unrealizedProfitUsd)} style={{ padding: "6px 4px", textAlign: "right" }}>
							{pnlSign(r.unrealizedProfitUsd)}{formatUsd(r.unrealizedProfitUsd)}
						</td>
						<td className={pnlClass(r.profitChange)} style={{ padding: "6px 4px", textAlign: "right" }}>
							{r.profitChange === null ? "—" : `${pnlSign(r.profitChange)}${(r.profitChange * 100).toFixed(1)}%`}
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

function ActivityList({ rows }: { rows: WalletStatsSummary["recentActivity"] }) {
	if (rows.length === 0) {
		return <p className="hint" style={{ margin: 0 }}>No recent activity.</p>;
	}
	return (
		<ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 4 }}>
			{rows.map((r, i) => (
				<li key={`${r.timestamp ?? i}-${r.tokenAddress ?? "?"}`} style={{ display: "flex", gap: 8, fontSize: 12, alignItems: "baseline" }}>
					<span className="hint" style={{ minWidth: 64 }}>{relTime(r.timestamp)}</span>
					<span style={{ minWidth: 40, textTransform: "uppercase" }} className={r.type === "buy" ? "pnl-positive" : r.type === "sell" ? "pnl-negative" : ""}>
						{r.type ?? "?"}
					</span>
					<span style={{ flex: 1 }}>{r.symbol ?? (r.tokenAddress ? shortAddr(r.tokenAddress) : "—")}</span>
					<span>{formatUsd(r.amountUsd)}</span>
				</li>
			))}
		</ul>
	);
}

export function WalletStatsPanel({ defaultSolana, defaultEvm }: Props) {
	const [chain, setChain] = useState<WalletStatsChain>("sol");
	const [period, setPeriod] = useState<WalletStatsPeriod>("7d");
	const [addressInput, setAddressInput] = useState<string>(defaultSolana ?? "");
	const [resp, setResp] = useState<WalletStatsResponse | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [showRaw, setShowRaw] = useState(false);

	const addressKind = useMemo(
		() => (CHAINS.find((c) => c.id === chain)?.addressKind ?? "solana"),
		[chain],
	);

	const trimmed = addressInput.trim();
	const looksEvm = /^0x[0-9a-fA-F]{40}$/.test(trimmed);
	const looksSolana = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed);
	const addressMismatch =
		trimmed.length > 0 &&
		((addressKind === "evm" && !looksEvm && looksSolana) ||
			(addressKind === "solana" && !looksSolana && looksEvm));

	// When chain switches kind, swap to the matching Phantom default if user
	// hasn't typed anything custom.
	useEffect(() => {
		const expected = addressKind === "solana" ? (defaultSolana ?? "") : (defaultEvm ?? "");
		setAddressInput((prev) => {
			const wasSolanaDefault = prev === (defaultSolana ?? "");
			const wasEvmDefault = prev === (defaultEvm ?? "");
			if (wasSolanaDefault || wasEvmDefault || prev === "") return expected;
			return prev;
		});
	}, [addressKind, defaultSolana, defaultEvm]);

	const load = useCallback(
		async (silent = false) => {
			const wallet = addressInput.trim();
			if (!wallet) {
				setResp(null);
				return;
			}
			if (!silent) setLoading(true);
			setError(null);
			try {
				const out = await rpc.request.walletStatsGet({ wallet, chain, period });
				setResp(out);
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			} finally {
				setLoading(false);
			}
		},
		[addressInput, chain, period],
	);

	useEffect(() => {
		if (!addressInput.trim()) return;
		if (addressMismatch) return;
		void load(true);
	}, [load, addressInput, addressMismatch]);

	const isUnconfigured = resp !== null && resp.configured === false;

	return (
		<section className="card" style={{ marginBottom: 12 }}>
			<div className="provider-header">
				<span className="name">Wallet stats (GMGN)</span>
				{loading ? <span className="badge">loading…</span> : null}
			</div>
			<div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
				<select value={chain} onChange={(e) => setChain(e.target.value as WalletStatsChain)} style={{ padding: "6px 10px" }}>
					{CHAINS.map((c) => (
						<option key={c.id} value={c.id}>{c.label}</option>
					))}
				</select>
				<select value={period} onChange={(e) => setPeriod(e.target.value as WalletStatsPeriod)} style={{ padding: "6px 10px" }}>
					<option value="7d">7d</option>
					<option value="30d">30d</option>
				</select>
				<input
					type="text"
					placeholder={addressKind === "solana" ? "Solana wallet address" : "EVM wallet address (0x…)"}
					value={addressInput}
					onChange={(e) => setAddressInput(e.target.value)}
					style={{ flex: 1, minWidth: 240, padding: "6px 10px" }}
					spellCheck={false}
				/>
				<button type="button" className="btn small secondary" onClick={() => void load(false)} disabled={loading}>
					{loading ? "…" : "Refresh"}
				</button>
			</div>

			{addressMismatch && (
				<div className="banner" style={{ marginBottom: 8 }}>
					That looks like a{looksEvm ? "n EVM" : " Solana"} address, but the chain is set to{" "}
					<strong>{CHAINS.find((c) => c.id === chain)?.label ?? chain}</strong>. Switch chain or paste a matching address.
				</div>
			)}

			{error && (
				<div className="banner error" style={{ marginBottom: 8 }}>
					{error}
				</div>
			)}

			{isUnconfigured && (
				<div className="banner" style={{ marginBottom: 8 }}>
					{resp.reason} Add <code>GMGN_API_KEY</code> to <code>.env</code> and restart Detour.
				</div>
			)}

			{resp !== null && resp.configured === true && (
				<>
					<div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
						<div>
							<div className="hint" style={{ fontSize: 11 }}>Total value</div>
							<div style={{ fontSize: 26, fontWeight: 700 }}>{formatUsd(resp.summary.totalUsdValue)}</div>
						</div>
						<div style={{ textAlign: "right" }}>
							<div className="hint" style={{ fontSize: 11 }}>Total P&L</div>
							<div className={pnlClass(resp.summary.totalPnlUsd)} style={{ fontSize: 22, fontWeight: 700 }}>
								{pnlSign(resp.summary.totalPnlUsd)}{formatUsd(resp.summary.totalPnlUsd)}
							</div>
							<div className="hint" style={{ fontSize: 10 }}>
								realized {pnlSign(resp.summary.totalRealizedUsd)}{formatUsd(resp.summary.totalRealizedUsd)}
								{" · "}
								unrealized {pnlSign(resp.summary.totalUnrealizedUsd)}{formatUsd(resp.summary.totalUnrealizedUsd)}
							</div>
						</div>
					</div>

					<StatStrip summary={resp.summary} />

					<div style={{ marginTop: 14 }}>
						<h4 style={{ margin: "0 0 6px", fontSize: 13 }}>Top positions</h4>
						{!resp.sections.holdings.parsed && resp.sections.holdings.error === null ? (
							<p className="hint" style={{ margin: "0 0 4px" }}>
								Couldn't parse holdings shape (keys: {resp.sections.holdings.rawKeys.join(", ") || "—"}). Raw payload available below.
							</p>
						) : null}
						{resp.sections.holdings.error ? (
							<p className="hint pnl-negative" style={{ margin: "0 0 4px" }}>
								holdings: {resp.sections.holdings.error}
							</p>
						) : null}
						<PositionsTable rows={resp.summary.topPositions} />
					</div>

					<div style={{ marginTop: 14 }}>
						<h4 style={{ margin: "0 0 6px", fontSize: 13 }}>Recent activity</h4>
						{!resp.sections.activity.parsed && resp.sections.activity.error === null ? (
							<p className="hint" style={{ margin: "0 0 4px" }}>
								Couldn't parse activity shape (keys: {resp.sections.activity.rawKeys.join(", ") || "—"}).
							</p>
						) : null}
						{resp.sections.activity.error ? (
							<p className="hint pnl-negative" style={{ margin: "0 0 4px" }}>
								activity: {resp.sections.activity.error}
							</p>
						) : null}
						<ActivityList rows={resp.summary.recentActivity} />
					</div>

					<div style={{ marginTop: 10, fontSize: 11 }} className="hint">
						Fetched {relTime(new Date(resp.fetchedAt).getTime())} from openapi.gmgn.ai · chain={resp.chain} · period={resp.period}
						{resp.sections.stats.error ? ` · stats: ${resp.sections.stats.error}` : ""}
					</div>

					<div style={{ marginTop: 8 }}>
						<button
							type="button"
							className="btn small secondary"
							onClick={() => setShowRaw((v) => !v)}
						>
							{showRaw ? "Hide" : "Show"} raw GMGN payload
						</button>
						{showRaw && (
							<pre
								style={{
									maxHeight: 320,
									overflow: "auto",
									fontSize: 11,
									background: "rgba(0,0,0,0.2)",
									padding: 8,
									marginTop: 6,
									borderRadius: 4,
								}}
							>{JSON.stringify(resp.raw, null, 2)}</pre>
						)}
					</div>
				</>
			)}
		</section>
	);
}
