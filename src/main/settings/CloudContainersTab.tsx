/**
 * Cloud > Containers tab — list Hetzner-Docker containers (hosted
 * agent runtimes) provisioned by the user's ElizaOS Cloud org.
 *
 * Read-only. Provisioning requires the cloud-side container control
 * plane (ssh2 + Hetzner API), which isn't worth re-implementing in
 * Detour. The tab links to the dashboard for create / start / stop.
 */

import { useEffect, useState } from "react";
import type {
	CloudContainer,
	CloudContainerStatus,
	CloudContainersList,
} from "../../shared/rpc/providers";
import { rpc } from "../rpc";

const STATUS_TONE: Record<CloudContainerStatus, string> = {
	pending: "muted",
	provisioning: "info",
	running: "ok",
	stopped: "muted",
	disconnected: "warn",
	error: "err",
	unknown: "muted",
};

const STATUS_LABEL: Record<CloudContainerStatus, string> = {
	pending: "Pending",
	provisioning: "Provisioning",
	running: "Running",
	stopped: "Stopped",
	disconnected: "Disconnected",
	error: "Error",
	unknown: "Unknown",
};

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

export function CloudContainersTab() {
	const [data, setData] = useState<CloudContainersList | null>(null);
	const [loading, setLoading] = useState(false);

	async function refresh() {
		setLoading(true);
		try {
			setData(await rpc.request.cloudListContainers({}));
		} catch (err) {
			setData({ containers: [], signedIn: false, error: err instanceof Error ? err.message : String(err) });
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		void refresh();
		const t = setInterval(refresh, 8000);
		return () => clearInterval(t);
	}, []);

	return (
		<div>
			<div className="provider-header" style={{ marginBottom: 16 }}>
				<div>
					<h3 style={{ margin: 0 }}>Cloud Containers</h3>
					<p className="hint" style={{ margin: "4px 0 0" }}>
						Hosted agent runtimes (Hetzner-Docker). Live status polled from
						ElizaOS Cloud every 8s.
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

			{data?.signedIn && (data.containers.length === 0 ? (
				<div className="empty">
					No containers provisioned.{" "}
					<button
						type="button"
						className="btn small"
						onClick={() => rpc.request.externalOpen({ url: "https://www.elizacloud.ai/dashboard/agents/new" })}
					>
						Provision one in the dashboard
					</button>
				</div>
			) : (
				<>
					{data.containers.map((c) => (
						<ContainerCard key={c.id} container={c} />
					))}
					<div className="row" style={{ marginTop: 12 }}>
						<button
							type="button"
							className="btn small"
							onClick={() => rpc.request.externalOpen({ url: "https://www.elizacloud.ai/dashboard/agents/new" })}
						>
							Provision agent
						</button>
						<button
							type="button"
							className="btn ghost small"
							onClick={() => rpc.request.externalOpen({ url: "https://www.elizacloud.ai/dashboard/agents" })}
						>
							Open dashboard
						</button>
					</div>
				</>
			))}
		</div>
	);
}

function ContainerCard({ container }: { container: CloudContainer }) {
	return (
		<div className="card">
			<div className="provider-header">
				<span className="name">{container.name ?? container.id}</span>
				<span className={`badge ${STATUS_TONE[container.status]}`}>
					{STATUS_LABEL[container.status]}
				</span>
			</div>
			<dl className="cloud-kv">
				{container.image && (
					<>
						<dt>Image</dt>
						<dd><code>{container.image}</code></dd>
					</>
				)}
				{container.host && (
					<>
						<dt>Host</dt>
						<dd><code>{container.host}</code></dd>
					</>
				)}
				{container.endpoint_url && (
					<>
						<dt>Endpoint</dt>
						<dd>
							<a
								href={container.endpoint_url}
								onClick={(e) => {
									e.preventDefault();
									if (container.endpoint_url) {
										rpc.request.externalOpen({ url: container.endpoint_url });
									}
								}}
							>
								{container.endpoint_url}
							</a>
						</dd>
					</>
				)}
				<dt>Created</dt>
				<dd>{fmtDate(container.created_at)}</dd>
				<dt>Updated</dt>
				<dd>{fmtDate(container.updated_at)}</dd>
			</dl>
			<div className="row" style={{ marginTop: 8 }}>
				<button
					type="button"
					className="btn ghost small"
					onClick={() => rpc.request.externalOpen({ url: `https://www.elizacloud.ai/dashboard/agents/${container.id}` })}
				>
					Manage
				</button>
			</div>
		</div>
	);
}
