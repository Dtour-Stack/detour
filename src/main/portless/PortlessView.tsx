/**
 * Portless tab — local-dev reverse proxy management.
 *
 * Single-pane view (no sidebar nav). Uses the same theme variables and
 * card/banner classes as Settings / Pensieve / Activity / Channels so
 * the visual language stays consistent across all of Detour's windows.
 */

import { useCallback, useEffect, useState } from "react";
import type { PortlessSnapshot } from "../../shared/index";
import { rpc } from "../rpc";
import { useDetourTheme } from "../useDetourTheme";

export function PortlessView() {
	useDetourTheme();
	const [snapshot, setSnapshot] = useState<PortlessSnapshot | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [hostname, setHostname] = useState("");
	const [port, setPort] = useState("3000");

	const refresh = useCallback(async () => {
		try {
			const s = await rpc.request.portlessStatus({});
			setSnapshot(s);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);

	useEffect(() => {
		void refresh();
		const t = setInterval(refresh, 3000);
		return () => clearInterval(t);
	}, [refresh]);

	const onAdd = useCallback(async () => {
		const portNum = Number.parseInt(port, 10);
		if (!hostname || !Number.isFinite(portNum)) {
			setError("hostname and a numeric port are required");
			return;
		}
		try {
			await rpc.request.portlessAddRoute({ hostname, port: portNum, force: true });
			setHostname("");
			setPort("3000");
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [hostname, port, refresh]);

	const onRemove = useCallback(async (h: string) => {
		try { await rpc.request.portlessRemoveRoute({ hostname: h }); await refresh(); }
		catch (err) { setError(err instanceof Error ? err.message : String(err)); }
	}, [refresh]);

	const onPrune = useCallback(async () => {
		try { await rpc.request.portlessPrune({}); await refresh(); }
		catch (err) { setError(err instanceof Error ? err.message : String(err)); }
	}, [refresh]);

	const proxyBase = snapshot ? `http://127.0.0.1:${snapshot.proxyPort}` : "";

	return (
		<div className="portless-shell">
			<header className="portless-header">
				<h1>Portless</h1>
				<p className="hint">
					Local-dev reverse proxy. Map <code>&lt;name&gt;.{snapshot?.tld ?? "localhost"}</code> hostnames to local ports.
				</p>
			</header>

			<section className="card">
				<div className="provider-header">
					<span className="name">Proxy</span>
					{snapshot?.running
						? <span className="badge ok">running on {proxyBase}</span>
						: <span className="badge err">down</span>}
				</div>
				<div className="hint">
					Test a registered route with{" "}
					<code>curl -H "Host: NAME.localhost" {proxyBase || "http://127.0.0.1:4848"}/</code>
				</div>
			</section>

			<section className="card">
				<h3>Register route</h3>
				<div className="row" style={{ gap: 8 }}>
					<input
						className="portless-input"
						placeholder="hostname (e.g. myapp or myapp.localhost)"
						value={hostname}
						onChange={(e) => setHostname(e.target.value)}
						style={{ flex: 2 }}
					/>
					<input
						className="portless-input"
						placeholder="port"
						value={port}
						onChange={(e) => setPort(e.target.value)}
						style={{ flex: 1 }}
					/>
					<button type="button" className="btn" onClick={onAdd}>Add</button>
				</div>
			</section>

			<section className="card">
				<div className="provider-header">
					<span className="name">Routes {snapshot ? `(${snapshot.routes.length})` : ""}</span>
					<button type="button" className="btn ghost small" onClick={onPrune}>
						Prune dead PIDs
					</button>
				</div>
				{snapshot?.routes.length === 0 && (
					<div className="empty">No routes registered yet.</div>
				)}
				<ul className="portless-routes">
					{snapshot?.routes.map((r) => (
						<li key={r.hostname} className="portless-route">
							<a
								href={`${proxyBase}/`}
								onClick={(e) => { e.preventDefault(); fetch(`${proxyBase}/`, { headers: { Host: r.hostname } }).catch(() => {}); }}
								className="portless-route-host"
								title={`http://${r.hostname}:${snapshot.proxyPort}/`}
							>
								<code>{r.hostname}</code>
							</a>
							<span className="portless-route-port">:{r.port}</span>
							<span className="portless-route-pid">pid {r.pid}</span>
							<button type="button" className="btn ghost small" onClick={() => onRemove(r.hostname)}>
								Remove
							</button>
						</li>
					))}
				</ul>
			</section>

			{error && <div className="banner error">{error}</div>}
		</div>
	);
}
