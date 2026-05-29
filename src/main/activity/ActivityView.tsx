import { useEffect, useState } from "react";
import { useDetourTheme } from "../useDetourTheme";
import { TrajectoriesPane } from "./TrajectoriesPane";
import { LogsPane } from "./LogsPane";
import { RuntimePane } from "./RuntimePane";
import { TasksPane } from "./TasksPane";
import { SubagentsPane } from "./SubagentsPane";
import { AutonomyPane } from "./AutonomyPane";
import { PluginsPane } from "./PluginsPane";
import { PrintingPressPane } from "./PrintingPressPane";
import { DbPane } from "./DbPane";

export type ActivityTab = "trajectories" | "logs" | "tasks" | "subagents" | "autonomy" | "plugins" | "tools" | "db" | "runtime";
type Tab = ActivityTab;

const TABS: { id: Tab; label: string }[] = [
	{ id: "trajectories", label: "Trajectories" },
	{ id: "logs", label: "Logs" },
	{ id: "tasks", label: "Tasks" },
	{ id: "subagents", label: "Subagents" },
	{ id: "autonomy", label: "Autonomy" },
	{ id: "plugins", label: "Plugins" },
	{ id: "tools", label: "Tools" },
	{ id: "db", label: "DB" },
	{ id: "runtime", label: "Runtime" },
];

/**
 * Top-level Activity view: trajectories + logs + tasks + runtime introspection.
 *
 * Rendered as a tab inside the Detour hub (App.tsx → renderToolView): tab nav
 * is a right-side rail that collapses to icons and expands on hover. Tab state
 * persists to localStorage.
 */
export function ActivityView({
	focusTab = null,
	onFocusApplied,
}: {
	/** One-shot deep-link from the hub (e.g. "Open Coding Agents" → "subagents"). */
	focusTab?: ActivityTab | null;
	/** Called once focusTab has been applied so the caller can clear it. */
	onFocusApplied?: () => void;
} = {}) {
	useDetourTheme();
	const [tab, setTab] = useState<Tab>(() => {
		try {
			return (localStorage.getItem("activity.tab") as Tab) ?? "trajectories";
		} catch {
			return "trajectories";
		}
	});

	useEffect(() => {
		try { localStorage.setItem("activity.tab", tab); } catch { /* ignore */ }
	}, [tab]);

	// Apply a one-shot focus request (works whether or not we're already
	// mounted), then signal the caller to clear it so normal navigation keeps
	// the user's last tab. onFocusApplied is intentionally out of the dep list
	// — the parent recreates it each render, and the focusTab→null transition
	// re-runs this effect to settle.
	useEffect(() => {
		if (focusTab) {
			setTab(focusTab);
			onFocusApplied?.();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [focusTab]);

	const content = (
		<>
			{tab === "trajectories" && <TrajectoriesPane />}
			{tab === "logs" && <LogsPane />}
			{tab === "tasks" && <TasksPane />}
			{tab === "subagents" && <SubagentsPane />}
			{tab === "autonomy" && <AutonomyPane />}
			{tab === "plugins" && <PluginsPane />}
			{tab === "tools" && <PrintingPressPane />}
			{tab === "db" && <DbPane />}
			{tab === "runtime" && <RuntimePane />}
		</>
	);

	return (
		<div className="embedded-view">
			<main className="embedded-main">{content}</main>
			<aside className="embedded-right-rail" aria-label="Activity tabs">
				<div className="embedded-right-rail-section-label">Runtime</div>
				{TABS.map((t) => (
					<button
						key={t.id}
						type="button"
						className={tab === t.id ? "embedded-right-rail-btn active" : "embedded-right-rail-btn"}
						onClick={() => setTab(t.id)}
						title={t.label}
					>
						<span className="embedded-right-rail-glyph">{t.label.slice(0, 2).toUpperCase()}</span>
						<span className="embedded-right-rail-label">{t.label}</span>
					</button>
				))}
			</aside>
		</div>
	);
}
