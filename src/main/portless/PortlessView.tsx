import { useCallback, useEffect, useState } from "react";
import type { PortlessSnapshot } from "../../shared/index";
import { WebClient } from "../api/client";
import { rpc } from "../rpc";
import { useDetourTheme } from "../useDetourTheme";

const client = new WebClient();

export function PortlessView() {
	useDetourTheme(client);
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
		<div style={{ padding: 16, fontFamily: "system-ui, -apple-system, sans-serif", color: "var(--text, #ddd)", background: "var(--bg, #0a0a0a)", minHeight: "100vh" }}>
			<header style={{ marginBottom: 16 }}>
				<h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Portless</h1>
				<p style={{ margin: "4px 0 0", fontSize: 12, opacity: 0.65 }}>
					Local-dev reverse proxy. Map <code>&lt;name&gt;.{snapshot?.tld ?? "localhost"}</code> hostnames to local ports.
				</p>
			</header>

			<section style={{ marginBottom: 16, padding: 12, background: "rgba(255,255,255,0.04)", borderRadius: 6, fontSize: 12 }}>
				<div>
					proxy:{" "}
					{snapshot?.running
						? <span style={{ color: "#7fd76a" }}>● running</span>
						: <span style={{ color: "#ff6b6b" }}>● down</span>}{" "}
					on <code>{proxyBase}</code>
				</div>
				<div style={{ marginTop: 4, opacity: 0.65 }}>
					Test a registered route with <code>curl -H "Host: NAME.localhost" {proxyBase || "http://127.0.0.1:4848"}/</code>
				</div>
			</section>

			<section style={{ marginBottom: 16 }}>
				<h2 style={{ fontSize: 13, fontWeight: 600, margin: "0 0 8px", opacity: 0.85 }}>Register route</h2>
				<div style={{ display: "flex", gap: 8 }}>
					<input
						placeholder="hostname (e.g. myapp or myapp.localhost)"
						value={hostname}
						onChange={(e) => setHostname(e.target.value)}
						style={{ flex: 2, padding: "6px 8px", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, color: "inherit", fontSize: 13 }}
					/>
					<input
						placeholder="port"
						value={port}
						onChange={(e) => setPort(e.target.value)}
						style={{ flex: 1, padding: "6px 8px", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, color: "inherit", fontSize: 13 }}
					/>
					<button onClick={onAdd} style={btnStyle()}>Add</button>
				</div>
			</section>

			<section>
				<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
					<h2 style={{ fontSize: 13, fontWeight: 600, margin: 0, opacity: 0.85 }}>
						Routes {snapshot ? `(${snapshot.routes.length})` : ""}
					</h2>
					<button onClick={onPrune} style={btnStyle({ subtle: true })}>Prune dead PIDs</button>
				</div>
				{snapshot?.routes.length === 0 && (
					<div style={{ padding: 16, fontSize: 12, opacity: 0.5, textAlign: "center" }}>No routes registered yet.</div>
				)}
				<ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
					{snapshot?.routes.map((r) => (
						<li key={r.hostname} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 10px", background: "rgba(255,255,255,0.03)", borderRadius: 4, marginBottom: 4, fontSize: 13 }}>
							<a
								href={`${proxyBase}/`}
								onClick={(e) => { e.preventDefault(); fetch(`${proxyBase}/`, { headers: { Host: r.hostname } }).catch(() => {}); }}
								style={{ flex: 1, color: "#7fb3ff", textDecoration: "none" }}
								title={`http://${r.hostname}:${snapshot.proxyPort}/`}
							>
								<code>{r.hostname}</code>
							</a>
							<span style={{ opacity: 0.6, fontFamily: "monospace" }}>:{r.port}</span>
							<span style={{ opacity: 0.4, fontSize: 11, fontFamily: "monospace" }}>pid {r.pid}</span>
							<button onClick={() => onRemove(r.hostname)} style={btnStyle({ danger: true })}>Remove</button>
						</li>
					))}
				</ul>
			</section>

			{error && (
				<div style={{ marginTop: 16, padding: 8, background: "rgba(255,80,80,0.15)", border: "1px solid rgba(255,80,80,0.4)", borderRadius: 4, fontSize: 12, color: "#ff9a9a" }}>
					{error}
				</div>
			)}
		</div>
	);
}

function btnStyle(opts: { danger?: boolean; subtle?: boolean } = {}) {
	const base: React.CSSProperties = {
		padding: "6px 12px",
		fontSize: 12,
		fontWeight: 500,
		border: "1px solid rgba(255,255,255,0.15)",
		borderRadius: 4,
		cursor: "pointer",
		color: "inherit",
		background: "rgba(255,255,255,0.06)",
	};
	if (opts.danger) {
		base.borderColor = "rgba(255,100,100,0.3)";
		base.color = "#ff9a9a";
	} else if (opts.subtle) {
		base.opacity = 0.6;
	}
	return base;
}
