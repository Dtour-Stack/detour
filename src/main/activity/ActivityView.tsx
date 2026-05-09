import { useEffect, useMemo, useState } from "react";
import { WebClient } from "../api/client";
import { useDetourTheme } from "../useDetourTheme";
import { TrajectoriesPane } from "./TrajectoriesPane";
import { LogsPane } from "./LogsPane";
import { RuntimePane } from "./RuntimePane";
import { TasksPane } from "./TasksPane";
import { AutonomyPane } from "./AutonomyPane";
import { PluginsPane } from "./PluginsPane";
import { DbPane } from "./DbPane";

type Tab = "trajectories" | "logs" | "tasks" | "autonomy" | "plugins" | "db" | "runtime";

const TABS: { id: Tab; label: string }[] = [
	{ id: "trajectories", label: "Trajectories" },
	{ id: "logs", label: "Logs" },
	{ id: "tasks", label: "Tasks" },
	{ id: "autonomy", label: "Autonomy" },
	{ id: "plugins", label: "Plugins" },
	{ id: "db", label: "DB" },
	{ id: "runtime", label: "Runtime" },
];

/**
 * Top-level Activity window: trajectories + logs + tasks + runtime introspection.
 * Mounts when the React app is loaded with location.hash === "#activity"
 * (the tray's activityFeature opens a new BrowserWindow with that URL).
 *
 * Layout matches settings-shell — left sidebar with section + sub-nav buttons,
 * main content area for the active pane.
 */
export function ActivityView() {
	const client = useMemo(() => new WebClient(), []);
	useDetourTheme(client);
	const [connected, setConnected] = useState(false);
	const [tab, setTab] = useState<Tab>(() => {
		try {
			return (localStorage.getItem("activity.tab") as Tab) ?? "trajectories";
		} catch {
			return "trajectories";
		}
	});

	useEffect(() => {
		client.connect().then(() => setConnected(true)).catch(() => setConnected(true));
	}, [client]);

	useEffect(() => {
		try { localStorage.setItem("activity.tab", tab); } catch { /* ignore */ }
	}, [tab]);

	return (
		<div className="settings-shell">
			<aside className="settings-sidebar">
				<div className="window-brand">Activity</div>
				<div className="sidebar-section">
					<div className="section-btn active" aria-hidden>Live runtime</div>
					<div className="sub-nav">
						{TABS.map((t) => (
							<button
								key={t.id}
								type="button"
								className={tab === t.id ? "sub-nav-btn active" : "sub-nav-btn"}
								onClick={() => setTab(t.id)}
							>
								{t.label}
							</button>
						))}
					</div>
				</div>
				<div style={{ flex: 1 }} />
				<div className="window-status">
					{connected ? "● connected" : "○ connecting…"}
				</div>
			</aside>
			<main className="settings-main settings-main-flush">
				{tab === "trajectories" && <TrajectoriesPane client={client} />}
				{tab === "logs" && <LogsPane client={client} />}
				{tab === "tasks" && <TasksPane client={client} />}
				{tab === "autonomy" && <AutonomyPane client={client} />}
				{tab === "plugins" && <PluginsPane client={client} />}
				{tab === "db" && <DbPane client={client} />}
				{tab === "runtime" && <RuntimePane client={client} />}
			</main>
		</div>
	);
}
