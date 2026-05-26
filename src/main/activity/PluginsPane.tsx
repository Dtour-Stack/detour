/**
 * Activity > Plugins pane.
 *
 * Per-plugin breakdown of what each registered eliza plugin contributes to
 * the runtime: actions, providers, evaluators, services, plus capability
 * flags (init/routes/models). Useful when debugging "why isn't action X
 * available?" — the answer is usually "the plugin that contributes it
 * didn't load."
 */

import { useCallback, useState } from "react";
import type { ActivityPluginDetail, ActivityPluginsSnapshot } from "../../shared/index";
import { UI_POLL_INTERVAL_MS } from "../../shared/timing";
import { rpc } from "../rpc";
import { usePoller } from "./usePoller";

export function PluginsPane() {
	const fetcher = useCallback(() => rpc.request.activityPluginsList({}), []);
	const { data, error, refresh } = usePoller<ActivityPluginsSnapshot>(fetcher, UI_POLL_INTERVAL_MS.activityPlugins);
	const [busy, setBusy] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);

	const rebuild = useCallback(async () => {
		if (!confirm("Rebuild the agent runtime? This re-runs init for every plugin and may briefly interrupt active conversations.")) return;
		setBusy(true);
		setActionError(null);
		try {
			await rpc.request.activityPluginsRebuild({});
			refresh();
		} catch (e) {
			setActionError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}, [refresh]);

	if (error) return <div className="banner error">{error}</div>;
	if (!data) return <div className="empty">Loading plugins…</div>;
	if (!data.available) {
		return <div className="empty" style={{ margin: 24 }}>Runtime not built yet.</div>;
	}

	return (
		<div className="plugins-pane">
			<div className="pensieve-toolbar">
				<span className="badge muted">{data.count} plugins</span>
				<span style={{ flex: 1 }} />
				<button type="button" className="btn small ghost" disabled={busy} onClick={rebuild}>
					{busy ? "Rebuilding…" : "Rebuild runtime"}
				</button>
			</div>

			{actionError && <div className="banner error" style={{ margin: "8px 18px 0" }}>{actionError}</div>}

			<div className="plugins-grid">
				{data.plugins.map((p) => <PluginCard key={p.name} plugin={p} />)}
			</div>
		</div>
	);
}

function PluginCard({ plugin }: { plugin: ActivityPluginDetail }) {
	const [open, setOpen] = useState(false);
	const total = plugin.actionCount + plugin.providerCount + plugin.evaluatorCount + plugin.serviceCount;
	return (
		<div className="plugin-card">
			<button type="button" className="plugin-card-header" onClick={() => setOpen((o) => !o)}>
				<span className="plugin-card-name">{plugin.name}</span>
				<span className="plugin-card-counts">
					{plugin.actionCount > 0 && <span className="badge info">{plugin.actionCount} act</span>}
					{plugin.providerCount > 0 && <span className="badge muted">{plugin.providerCount} prov</span>}
					{plugin.evaluatorCount > 0 && <span className="badge muted">{plugin.evaluatorCount} eval</span>}
					{plugin.serviceCount > 0 && <span className="badge ok">{plugin.serviceCount} svc</span>}
					{total === 0 && <span className="hint">passive</span>}
					{plugin.hasInit && <span className="badge muted" title="has init() hook">init</span>}
					{plugin.hasRoutes && <span className="badge muted" title="exposes HTTP routes">routes</span>}
					{plugin.hasModels && <span className="badge muted" title="provides model handlers">models</span>}
				</span>
				<span className="plugin-card-twirl">{open ? "▾" : "▸"}</span>
			</button>
			{plugin.description && <p className="plugin-card-desc">{plugin.description}</p>}
			{open && (
				<div className="plugin-card-body">
					{plugin.actionNames.length > 0 && (
						<NamesBlock label="Actions" names={plugin.actionNames} tone="info" />
					)}
					{plugin.providerNames.length > 0 && (
						<NamesBlock label="Providers" names={plugin.providerNames} tone="muted" />
					)}
					{plugin.evaluatorNames.length > 0 && (
						<NamesBlock label="Evaluators" names={plugin.evaluatorNames} tone="muted" />
					)}
					{plugin.serviceTypes.length > 0 && (
						<NamesBlock label="Services" names={plugin.serviceTypes} tone="ok" />
					)}
				</div>
			)}
		</div>
	);
}

function NamesBlock({ label, names, tone }: { label: string; names: string[]; tone: string }) {
	return (
		<div className="plugin-card-block">
			<div className="plugin-card-block-label">{label}</div>
			<div className="plugin-card-block-names">
				{names.map((n) => <span key={n} className={`badge ${tone}`}>{n}</span>)}
			</div>
		</div>
	);
}
