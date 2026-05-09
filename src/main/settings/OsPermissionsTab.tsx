import { useEffect, useState } from "react";
import type { OsPermissionInfo, OsPermissionStatus } from "../../shared/index";
import type { WebClient } from "../api/client";

const STATUS_TONE: Record<OsPermissionStatus, string> = {
	granted: "ok",
	denied: "err",
	unknown: "muted",
	"not-applicable": "muted",
};

const STATUS_LABEL: Record<OsPermissionStatus, string> = {
	granted: "Granted",
	denied: "Denied",
	unknown: "Unknown",
	"not-applicable": "N/A",
};

export function OsPermissionsTab({ client }: { client: WebClient }) {
	const [perms, setPerms] = useState<OsPermissionInfo[] | null>(null);
	const [refreshing, setRefreshing] = useState(false);

	async function refresh() {
		setRefreshing(true);
		try {
			setPerms(await client.listOsPermissions());
		} finally {
			setRefreshing(false);
		}
	}

	useEffect(() => {
		void refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	async function openPane(id: OsPermissionInfo["id"]) {
		await client.openOsPermissionPane(id).catch(() => {});
	}

	if (!perms) return <div className="hint">Probing OS permissions…</div>;

	const native = perms.filter((p) => p.status !== "not-applicable");
	const naSet = perms.find((p) => p.status === "not-applicable");

	return (
		<div>
			<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
				<h3 style={{ margin: 0 }}>OS permissions</h3>
				<button
					type="button"
					className="btn ghost small"
					onClick={refresh}
					disabled={refreshing}
				>
					{refreshing ? "Probing…" : "Re-probe"}
				</button>
			</div>
			<p className="hint">
				macOS TCC permissions controlling what the agent can do on your machine.
				Probing is best-effort — when a status is <em>Unknown</em>, open System Settings to verify or grant.
			</p>

			{naSet && (
				<div className="banner warn">
					This is a {naSet.detail?.split(":")[0] ?? "non-macOS"} system. macOS TCC permissions don't apply.
				</div>
			)}

			{native.map((p) => (
				<div className="card" key={p.id}>
					<div className="provider-header">
						<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
							<span className="name">{p.label}</span>
							<span className={`badge ${STATUS_TONE[p.status]}`}>{STATUS_LABEL[p.status]}</span>
						</div>
						{p.settingsUrl && (
							<button
								type="button"
								className="btn secondary small"
								onClick={() => openPane(p.id)}
							>
								Open System Settings
							</button>
						)}
					</div>
					<div style={{ fontSize: 12, color: "var(--fg-muted)", marginBottom: p.detail ? 6 : 0 }}>
						<strong>Enables:</strong> {p.enables}
					</div>
					{p.detail && (
						<div style={{ fontSize: 11, color: "var(--fg-subtle)", fontFamily: "ui-monospace, Menlo, monospace", marginTop: 4 }}>
							{p.detail}
						</div>
					)}
				</div>
			))}

			<div className="card" style={{ borderStyle: "dashed", opacity: 0.85 }}>
				<div className="provider-header">
					<span className="name">Elevated (sudo) access</span>
					<span className="badge muted">Not supported</span>
				</div>
				<div style={{ fontSize: 12, color: "var(--fg-muted)" }}>
					Running agent commands as root requires a privileged helper tool (LaunchDaemon
					or SMJobBless). Not implemented yet — out of scope for this build. The agent
					currently runs with your user-level permissions only.
				</div>
			</div>
		</div>
	);
}
