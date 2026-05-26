import { useCallback } from "react";
import type { ActivityRuntimeRegistryItem, ActivityRuntimeSnapshot } from "../../shared/index";
import { UI_POLL_INTERVAL_MS } from "../../shared/timing";
import { rpc } from "../rpc";
import { usePoller } from "./usePoller";

/**
 * The Plugins tab is canonical for plugin contributions (see
 * PluginsPane). Runtime pane only mirrors the live in-process
 * registries (actions, providers, evaluators, services) so they stay
 * non-overlapping.
 */
const REGISTRIES: { key: keyof Pick<ActivityRuntimeSnapshot, "actions" | "providers" | "evaluators" | "services">; label: string }[] = [
	{ key: "actions", label: "Actions" },
	{ key: "providers", label: "Providers" },
	{ key: "evaluators", label: "Evaluators" },
	{ key: "services", label: "Services" },
];

function ItemRow({ item }: { item: ActivityRuntimeRegistryItem }) {
	return (
		<div className="pensieve-runtime-item">
			<div className="pensieve-runtime-name">
				{item.name}
				{item.className && <span className="pensieve-runtime-class">{item.className}</span>}
			</div>
			{item.description && <div className="pensieve-runtime-desc">{item.description}</div>}
		</div>
	);
}

export function RuntimePane() {
	const fetcher = useCallback(() => rpc.request.activityRuntime({}), []);
	const { data, error } = usePoller<ActivityRuntimeSnapshot>(fetcher, UI_POLL_INTERVAL_MS.default);

	if (error) return <div className="banner error">{error}</div>;
	if (!data) return <div className="hint">Loading runtime snapshot…</div>;
	if (!data.available) {
		return (
			<div className="empty">
				Runtime not available yet — send a chat message to initialise the agent.
			</div>
		);
	}

	return (
		<div className="pensieve-runtime">
			<div className="pensieve-runtime-summary">
				<div><strong>{data.agentName ?? "agent"}</strong> {data.agentId && <span className="hint">({data.agentId.slice(0, 8)})</span>}</div>
				<div className="hint" style={{ marginTop: 4 }}>
					{data.counts.actions} actions · {data.counts.providers} providers ·{" "}
					{data.counts.evaluators} evaluators · {data.counts.services} services
					{data.counts.plugins > 0 && (
						<>
							{" "}· <span style={{ opacity: 0.7 }}>{data.counts.plugins} plugins (see Plugins tab)</span>
						</>
					)}
				</div>
			</div>
			{REGISTRIES.map(({ key, label }) => {
				const items = data[key];
				return (
					<details key={key} open={key === "actions"} className="pensieve-runtime-section">
						<summary>{label} <span className="hint">({items.length})</span></summary>
						<div className="pensieve-runtime-items">
							{items.map((it) => <ItemRow key={`${it.name}-${it.id ?? ""}`} item={it} />)}
							{items.length === 0 && <div className="hint" style={{ padding: 8 }}>(none)</div>}
						</div>
					</details>
				);
			})}
		</div>
	);
}
