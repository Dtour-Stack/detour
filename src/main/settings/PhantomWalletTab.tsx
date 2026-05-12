import { useCallback, useEffect, useState } from "react";
import { rpc } from "../rpc";

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

export function PhantomWalletTab() {
	const [cfg, setCfg] = useState<PortalCfg | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [toast, setToast] = useState<string | null>(null);

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
