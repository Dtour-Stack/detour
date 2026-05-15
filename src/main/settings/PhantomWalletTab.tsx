import { useCallback, useEffect, useState } from "react";
import { AddressType, ConnectButton, useDisconnect, usePhantom } from "@phantom/react-sdk";
import { rpc } from "../rpc";
import { useDetourPhantomStatus } from "../wallet/DetourPhantomRoot";
import { WalletStatsPanel } from "../wallet/WalletStatsPanel";

type PortalCfg = {
	appId: string | null;
	redirectUrl: string | null;
	portalAllowedOrigins: string[];
	portalRedirectUrls: string[];
};

async function copyText(label: string, text: string, onDone: (msg: string | null) => void) {
	try {
		await navigator.clipboard.writeText(text);
		onDone(`Copied ${label}`);
		setTimeout(() => onDone(null), 2000);
	} catch {
		onDone("Copy failed — select the text manually");
		setTimeout(() => onDone(null), 3000);
	}
}

function shortAddress(value: string): string {
	return value.length > 14 ? `${value.slice(0, 6)}...${value.slice(-6)}` : value;
}

function ConnectedWalletStats() {
	const { addresses } = usePhantom();
	const solana = addresses.find((a) => a.addressType === AddressType.solana)?.address ?? null;
	const ethereum = addresses.find((a) => a.addressType === AddressType.ethereum)?.address ?? null;
	return <WalletStatsPanel defaultSolana={solana} defaultEvm={ethereum} />;
}

function PhantomWalletConnectionCard() {
	const { addresses, isConnected, isConnecting } = usePhantom();
	const { disconnect, isDisconnecting, error } = useDisconnect();
	const [disconnectError, setDisconnectError] = useState<string | null>(null);
	const solana = addresses.find((address) => address.addressType === AddressType.solana);
	const ethereum = addresses.find((address) => address.addressType === AddressType.ethereum);

	const onDisconnect = useCallback(async () => {
		setDisconnectError(null);
		try {
			await disconnect();
		} catch (err) {
			setDisconnectError(err instanceof Error ? err.message : String(err));
		}
	}, [disconnect]);

	return (
		<section className="card" style={{ marginBottom: 12 }}>
			<div className="provider-header">
				<span className="name">Wallet connection</span>
				{isConnected ? <span className="badge ok">connected</span> : <span className="badge">ready</span>}
			</div>
			<div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8 }}>
				<ConnectButton addressType={AddressType.solana} fullWidth />
				<ConnectButton addressType={AddressType.ethereum} fullWidth />
			</div>
			{isConnecting && <p className="hint" style={{ marginBottom: 0 }}>Connecting to Phantom...</p>}
			{isConnected && (
				<div style={{ display: "grid", gap: 8, marginTop: 12 }}>
					<div style={{ display: "grid", gap: 4 }}>
						<span className="hint">Solana</span>
						<code style={{ wordBreak: "break-all" }}>{solana ? shortAddress(solana.address) : "not connected"}</code>
					</div>
					<div style={{ display: "grid", gap: 4 }}>
						<span className="hint">EVM</span>
						<code style={{ wordBreak: "break-all" }}>{ethereum ? shortAddress(ethereum.address) : "not connected"}</code>
					</div>
					<button
						type="button"
						className="btn small secondary"
						onClick={() => void onDisconnect()}
						disabled={isDisconnecting}
					>
						{isDisconnecting ? "Disconnecting..." : "Disconnect"}
					</button>
				</div>
			)}
			{(disconnectError || error) && (
				<div className="banner error" style={{ marginTop: 12 }}>
					{disconnectError ?? error?.message}
				</div>
			)}
		</section>
	);
}

export function PhantomWalletTab() {
	const [cfg, setCfg] = useState<PortalCfg | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [toast, setToast] = useState<string | null>(null);
	const phantomStatus = useDetourPhantomStatus();

	const refresh = useCallback(async () => {
		try {
			const c = await rpc.request.phantomGetPortalConfig({});
			setCfg(c);
			setErr(null);
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
			setCfg(null);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const ready = Boolean(cfg?.appId);

	return (
		<div className="settings-pane" style={{ padding: 16, maxWidth: 720 }}>
			<h3 style={{ margin: "0 0 8px" }}>Phantom wallet</h3>
			<p className="hint" style={{ marginBottom: 16 }}>
				Embedded Connect runs in Detour’s webview. Open{" "}
				<a href="https://portal.phantom.com" target="_blank" rel="noreferrer">
					Phantom Portal
				</a>{" "}
				→ your app → paste the values below into{" "}
				<strong>Allowed Origins</strong> and <strong>Redirect URLs</strong> (exact match).
			</p>

			{toast && (
				<div className="banner success" style={{ marginBottom: 12 }}>
					{toast}
				</div>
			)}
			{err && (
				<div className="banner error" style={{ marginBottom: 12 }}>
					{err}
				</div>
			)}

			{phantomStatus.ready ? (
				<>
					<PhantomWalletConnectionCard />
					<ConnectedWalletStats />
				</>
			) : (
				<section className="card" style={{ marginBottom: 12 }}>
					<div className="provider-header">
						<span className="name">Wallet connection</span>
						<span className={phantomStatus.state === "loading" ? "badge" : "badge err"}>
							{phantomStatus.state === "loading" ? "loading" : "offline"}
						</span>
					</div>
					<p className="hint" style={{ margin: 0 }}>
						Load App ID and Redirect URL below, then restart Detour if the provider stays offline.
					</p>
				</section>
			)}

			<section className="card" style={{ marginBottom: 12 }}>
				<div className="provider-header">
					<span className="name">App ID (env)</span>
					{ready ? <span className="badge ok">loaded</span> : <span className="badge err">missing</span>}
				</div>
				{cfg?.appId ? (
					<div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
						<code style={{ wordBreak: "break-all", flex: 1 }}>{cfg.appId}</code>
						<button type="button" className="btn small secondary" onClick={() => void copyText("App ID", cfg.appId!, setToast)}>
							Copy
						</button>
					</div>
				) : (
					<p className="hint" style={{ margin: 0 }}>
						Set <code>PHANTOM_CONNECT_APP_ID</code> in the repo <code>.env</code> (already created for this
						workspace if you pulled latest) and restart Detour.
					</p>
				)}
			</section>

			<section className="card" style={{ marginBottom: 12 }}>
				<div className="provider-header">
					<span className="name">Redirect URL (SDK)</span>
					{cfg?.redirectUrl ? <span className="badge ok">resolved</span> : <span className="badge err">none</span>}
				</div>
				{cfg?.redirectUrl ? (
					<div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
						<code style={{ wordBreak: "break-all", flex: 1 }}>{cfg.redirectUrl}</code>
						<button
							type="button"
							className="btn small secondary"
							onClick={() => void copyText("redirect URL", cfg.redirectUrl!, setToast)}
						>
							Copy
						</button>
					</div>
				) : (
					<p className="hint" style={{ margin: 0 }}>
						Set <code>PHANTOM_CONNECT_REDIRECT_URL</code>, or <code>DETOUR_DEV_URL</code> (tunnel = public
						origin), or run portless + <code>PHANTOM_PORTLESS_FQDN</code>. See{" "}
						<code>src/bun/core/rpc/handlers/phantom.ts</code>.
					</p>
				)}
			</section>

			<section className="card" style={{ marginBottom: 12 }}>
				<h4 style={{ margin: "0 0 8px" }}>Portal → Allowed Origins</h4>
				{cfg?.portalAllowedOrigins?.length ? (
					<ul style={{ margin: 0, paddingLeft: 18 }}>
						{cfg.portalAllowedOrigins.map((o) => (
							<li key={o} style={{ marginBottom: 6 }}>
								<div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
									<code style={{ wordBreak: "break-all", flex: 1 }}>{o}</code>
									<button type="button" className="btn small secondary" onClick={() => void copyText("origin", o, setToast)}>
										Copy
									</button>
								</div>
							</li>
						))}
					</ul>
				) : (
					<p className="hint" style={{ margin: 0 }}>
						{cfg?.portalAllowedOrigins?.length
							? "Add a redirect URL (see above) — origins are ready for Portal."
							: "Resolve a redirect URL first (see above)."}
					</p>
				)}
			</section>

			<section className="card" style={{ marginBottom: 12 }}>
				<h4 style={{ margin: "0 0 8px" }}>Portal → Redirect URLs</h4>
				{cfg?.portalRedirectUrls?.length ? (
					<ul style={{ margin: 0, paddingLeft: 18 }}>
						{cfg.portalRedirectUrls.map((u) => (
							<li key={u} style={{ marginBottom: 6 }}>
								<div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
									<code style={{ wordBreak: "break-all", flex: 1 }}>{u}</code>
									<button type="button" className="btn small secondary" onClick={() => void copyText("redirect", u, setToast)}>
										Copy
									</button>
								</div>
							</li>
						))}
					</ul>
				) : (
					<p className="hint" style={{ margin: 0 }}>Same as “Redirect URL (SDK)” once resolved.</p>
				)}
			</section>

			<button type="button" className="btn small secondary" onClick={() => void refresh()}>
				Refresh from Bun
			</button>
		</div>
	);
}
