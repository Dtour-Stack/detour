import { useEffect, useMemo, useState } from "react";
import { WebClient } from "../../api/client";
import { ActivityPane } from "./ActivityPane";

/**
 * Top-level Activity window: trajectories + logs + runtime introspection.
 * Mounts when the React app is loaded with location.hash === "#activity"
 * (the tray's activityFeature opens a new BrowserWindow with that URL).
 */
export function ActivityView() {
	const client = useMemo(() => new WebClient(), []);
	const [connected, setConnected] = useState(false);

	useEffect(() => {
		client.connect().then(() => setConnected(true)).catch(() => setConnected(true));
	}, [client]);

	return (
		<div className="pensieve-shell">
			<aside className="pensieve-sidebar">
				<div className="pensieve-brand">Activity</div>
				<div className="hint" style={{ padding: "0 14px", lineHeight: 1.5 }}>
					Live runtime introspection — trajectories, logs, and registered actions/providers/services.
				</div>
				<div style={{ flex: 1 }} />
				<div className="pensieve-status">
					{connected ? "● connected" : "○ connecting…"}
				</div>
			</aside>
			<main className="pensieve-main">
				<ActivityPane client={client} />
			</main>
		</div>
	);
}
