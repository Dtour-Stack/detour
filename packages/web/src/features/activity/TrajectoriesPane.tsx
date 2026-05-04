import { useCallback, useState } from "react";
import type { PensieveTrajectoryListResult } from "@detour/shared";
import type { WebClient } from "../../api/client";
import { usePoller } from "./usePoller";

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

export function TrajectoriesPane({ client }: { client: WebClient }) {
	const [selected, setSelected] = useState<string | null>(null);
	const [status, setStatus] = useState<string>("");
	const fetcher = useCallback(
		() => client.pensieveTrajectories({ limit: 100, ...(status ? { status } : {}) }),
		[client, status],
	);
	const { data, error } = usePoller<PensieveTrajectoryListResult>(fetcher, 5000, [status]);

	if (error) return <div className="banner error">{error}</div>;

	return (
		<div className="pensieve-trajectories">
			<div className="pensieve-toolbar">
				<select value={status} onChange={(e) => setStatus(e.target.value)} className="pensieve-select">
					<option value="">All statuses</option>
					<option value="active">Active</option>
					<option value="completed">Completed</option>
					<option value="error">Errored</option>
				</select>
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
						onClick={() => setSelected(selected === t.id ? null : t.id)}
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
	);
}

function statusTone(s?: string): string {
	if (s === "completed") return "ok";
	if (s === "error") return "err";
	if (s === "active") return "info";
	return "muted";
}
