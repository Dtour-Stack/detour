/**
 * Cloud > Apps tab — list user-owned apps registered in ElizaOS Cloud.
 *
 * Read-only on the Detour side. Apps are created via the elizacloud.ai
 * dashboard (provisioning flow handles GitHub repo + API key minting,
 * which doesn't fit cleanly inside a tray app). The tab links out for
 * create + edit; everything else is just a status view.
 */

import { useEffect, useState } from "react";
import type { CloudApp, CloudAppsList } from "../../shared/rpc/providers";
import { rpc } from "../rpc";

function fmtDate(iso?: string): string {
	if (!iso) return "—";
	try {
		const d = new Date(iso);
		const ms = Date.now() - d.getTime();
		const days = Math.floor(ms / 86_400_000);
		if (days >= 1) return `${days}d ago`;
		const hours = Math.floor(ms / 3_600_000);
		if (hours >= 1) return `${hours}h ago`;
		const mins = Math.floor(ms / 60_000);
		return mins >= 1 ? `${mins}m ago` : "just now";
	} catch {
		return iso;
	}
}

export function CloudAppsTab() {
	const [data, setData] = useState<CloudAppsList | null>(null);
	const [loading, setLoading] = useState(false);

	async function refresh() {
		setLoading(true);
		try {
			setData(await rpc.request.cloudListApps({}));
		} catch (err) {
			setData({ apps: [], signedIn: false, error: err instanceof Error ? err.message : String(err) });
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		void refresh();
	}, []);

	return (
		<div>
			<div className="provider-header" style={{ marginBottom: 16 }}>
				<div>
					<h3 style={{ margin: 0 }}>Cloud Apps</h3>
					<p className="hint" style={{ margin: "4px 0 0" }}>
						Client apps registered to your ElizaOS Cloud organization. Each one
						has its own API key and (optional) GitHub repo.
					</p>
				</div>
				<button
					type="button"
					className="btn ghost small"
					onClick={() => void refresh()}
					disabled={loading}
				>
					{loading ? "Refreshing…" : "Refresh"}
				</button>
			</div>

			{!data?.signedIn && (
				<div className="banner warn">
					Sign in via Cloud → ElizaOS Cloud first.
					{data?.error && <div style={{ marginTop: 4, fontSize: 12 }}>{data.error}</div>}
				</div>
			)}

			{data?.signedIn && data.error && (
				<div className="banner error">{data.error}</div>
			)}

			{data?.signedIn && (data.apps.length === 0 ? (
				<div className="empty">
					No apps yet.{" "}
					<button
						type="button"
						className="btn ghost small"
						onClick={() => rpc.request.externalOpen({ url: "https://www.elizacloud.ai/dashboard/apps/new" })}
					>
						Create one in the dashboard
					</button>
				</div>
			) : (
				<>
					{data.apps.map((app) => (
						<AppCard key={app.id} app={app} />
					))}
					<div className="row" style={{ marginTop: 12 }}>
						<button
							type="button"
							className="btn small"
							onClick={() => rpc.request.externalOpen({ url: "https://www.elizacloud.ai/dashboard/apps/new" })}
						>
							New app
						</button>
						<button
							type="button"
							className="btn ghost small"
							onClick={() => rpc.request.externalOpen({ url: "https://www.elizacloud.ai/dashboard/apps" })}
						>
							Open dashboard
						</button>
					</div>
				</>
			))}
		</div>
	);
}

function AppCard({ app }: { app: CloudApp }) {
	return (
		<div className="card">
			<div className="provider-header">
				<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
					{app.logo_url && (
						<img
							src={app.logo_url}
							alt=""
							width={24}
							height={24}
							style={{ borderRadius: 4 }}
						/>
					)}
					<span className="name">{app.name}</span>
				</div>
				<button
					type="button"
					className="btn ghost small"
					onClick={() => rpc.request.externalOpen({ url: `https://www.elizacloud.ai/dashboard/apps/${app.id}` })}
				>
					Manage
				</button>
			</div>
			{app.description && (
				<div className="hint" style={{ marginBottom: 6 }}>{app.description}</div>
			)}
			<dl className="cloud-kv">
				{app.app_url && (
					<>
						<dt>App URL</dt>
						<dd><code>{app.app_url}</code></dd>
					</>
				)}
				{app.website_url && (
					<>
						<dt>Website</dt>
						<dd><code>{app.website_url}</code></dd>
					</>
				)}
				<dt>Created</dt>
				<dd>{fmtDate(app.created_at)}</dd>
			</dl>
		</div>
	);
}
