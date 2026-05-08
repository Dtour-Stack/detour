import { useCallback, useState } from "react";
import type { ActivityTrajectoryListResult } from "@detour/shared";
import type { WebClient } from "../_shared/api/client";
import { usePoller } from "./usePoller";
import { TrajectoryDetail } from "./TrajectoryDetail";

function fmtMs(ms?: number): string {
	if (typeof ms !== "number") return "–";
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${(ms / 60000).toFixed(1)}m`;
}

function fmtTime(ts?: number): string {
	if (!ts) return "–";
	return new Date(ts).toLocaleString();
}

function downloadJson(filename: string, data: unknown) {
	const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

export function TrajectoriesPane({ client }: { client: WebClient }) {
	const [selected, setSelected] = useState<string | null>(null);
	const [status, setStatus] = useState<string>("");
	const [exporting, setExporting] = useState(false);
	const fetcher = useCallback(
		() => client.activityTrajectories({ limit: 100, ...(status ? { status } : {}) }),
		[client, status],
	);
	const { data, error } = usePoller<ActivityTrajectoryListResult>(fetcher, 5000, [status]);

	const handleExportAll = useCallback(async () => {
		setExporting(true);
		try {
			const payload = await client.activityExportTrajectories();
			downloadJson(`detour-trajectories-${Date.now()}.json`, payload);
		} catch (e) {
			console.error("export failed", e);
			alert(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setExporting(false);
		}
	}, [client]);

	if (error) return <div className="banner error">{error}</div>;

	return (
		<div className="pensieve-split" style={{ height: "100%" }}>
			<div className="pensieve-split-list">
				<div className="pensieve-toolbar">
					<select value={status} onChange={(e) => setStatus(e.target.value)} className="pensieve-select">
						<option value="">All statuses</option>
						<option value="active">Active</option>
						<option value="completed">Completed</option>
						<option value="error">Errored</option>
					</select>
					<button
						type="button"
						className="btn small ghost"
						disabled={exporting || !data?.trajectories.length}
						onClick={handleExportAll}
						title="Download every trajectory as JSON"
					>
						{exporting ? "Exporting…" : "Export all"}
					</button>
					<span className="hint" style={{ marginLeft: "auto" }}>
						{data ? `${data.trajectories.length} of ${data.total}` : "loading…"}
					</span>
				</div>
				<div className="pensieve-trajectories-list">
					{(data?.trajectories ?? []).map((t) => (
						<button
							key={t.id}
							type="button"
							className={selected === t.id ? "pensieve-trajectory-row active" : "pensieve-trajectory-row"}
							onClick={() => setSelected(t.id)}
						>
							<div className="pensieve-trajectory-header">
								<span className={`badge ${statusTone(t.status)}`}>{t.status ?? "?"}</span>
								{t.source && <span className="badge muted">{t.source}</span>}
								<span className="hint">{fmtTime(t.startTime)}</span>
								<span className="hint">·</span>
								<span className="hint">{fmtMs(t.durationMs)}</span>
							</div>
							<div className="hint" style={{ marginTop: 4 }}>
								{t.llmCallCount ?? 0} LLM calls · {t.totalPromptTokens ?? 0}↑ / {t.totalCompletionTokens ?? 0}↓ tokens
							</div>
							<div className="pensieve-trajectory-id">{t.id}</div>
						</button>
					))}
					{data && data.trajectories.length === 0 && (
						<div className="empty">No trajectories yet — send a chat message to generate one.</div>
					)}
				</div>
			</div>
			<div className="pensieve-split-detail">
				{selected ? (
					<TrajectoryDetail
						client={client}
						trajectoryId={selected}
						onClose={() => setSelected(null)}
					/>
				) : (
					<div className="empty" style={{ marginTop: 40 }}>
						Select a trajectory to inspect its pipeline, LLM calls, and provider accesses.
					</div>
				)}
			</div>
		</div>
	);
}

function statusTone(s?: string): string {
	if (s === "completed") return "ok";
	if (s === "error") return "err";
	if (s === "active") return "info";
	return "muted";
}
