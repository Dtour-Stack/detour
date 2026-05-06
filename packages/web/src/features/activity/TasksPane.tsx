/**
 * Activity > Tasks pane.
 *
 * Surfaces elizaOS's TaskService — registered TaskWorkers (action types the
 * agent can do autonomously) plus persisted Tasks (recurring + one-shot)
 * with paused/failure/lastRun status. Per-row Run/Pause/Resume/Delete.
 */

import { useCallback, useState } from "react";
import type { ActivityTasksSnapshot } from "@detour/shared";
import type { WebClient } from "../../api/client";
import { usePoller } from "./usePoller";

function fmtTime(ts?: number): string {
	if (!ts) return "—";
	const ms = ts < 1e12 ? ts * 1000 : ts;
	return new Date(ms).toLocaleString();
}

function fmtRelative(ts?: number): string {
	if (!ts) return "—";
	const ms = ts < 1e12 ? ts * 1000 : ts;
	const diff = ms - Date.now();
	const abs = Math.abs(diff);
	const sign = diff < 0 ? "-" : "+";
	if (abs < 60_000) return `${sign}${Math.round(abs / 1000)}s`;
	if (abs < 3_600_000) return `${sign}${Math.round(abs / 60_000)}m`;
	if (abs < 86_400_000) return `${sign}${Math.round(abs / 3_600_000)}h`;
	return `${sign}${Math.round(abs / 86_400_000)}d`;
}

function fmtInterval(ms?: number): string {
	if (!ms) return "—";
	if (ms < 1000) return "<1s";
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
	if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
	return `${Math.round(ms / 86_400_000)}d`;
}

export function TasksPane({ client }: { client: WebClient }) {
	const [busyId, setBusyId] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const fetcher = useCallback(() => client.activityTasks(), [client]);
	const { data, error, refresh } = usePoller<ActivityTasksSnapshot>(fetcher, 5000);

	const act = useCallback(
		async (id: string, op: "run" | "pause" | "resume" | "delete") => {
			setBusyId(id);
			setActionError(null);
			try {
				if (op === "run") await client.activityRunTask(id);
				else if (op === "pause") await client.activityPauseTask(id);
				else if (op === "resume") await client.activityResumeTask(id);
				else if (op === "delete") {
					if (!confirm("Delete this task? This cannot be undone.")) return;
					await client.activityDeleteTask(id);
				}
				refresh();
			} catch (e) {
				setActionError(e instanceof Error ? e.message : String(e));
			} finally {
				setBusyId(null);
			}
		},
		[client, refresh],
	);

	if (error) return <div className="banner error">{error}</div>;
	if (!data) return <div className="empty">Loading tasks…</div>;
	if (!data.available) {
		return <div className="empty">Task service not available — runtime not ready.</div>;
	}

	return (
		<div className="pensieve-tasks">
			{actionError && <div className="banner error" style={{ margin: "10px 18px 0" }}>{actionError}</div>}

			<div className="pensieve-toolbar">
				<span className="badge muted">{data.totals.workerCount} workers</span>
				<span className="badge muted">{data.totals.taskCount} tasks</span>
				{data.totals.recurringCount > 0 && (
					<span className="badge info">{data.totals.recurringCount} recurring</span>
				)}
				{data.totals.pausedCount > 0 && (
					<span className="badge warn">{data.totals.pausedCount} paused</span>
				)}
				{data.totals.failingCount > 0 && (
					<span className="badge err">{data.totals.failingCount} failing</span>
				)}
				<span className="hint" style={{ marginLeft: "auto" }}>polling 5s</span>
			</div>

			<div className="pensieve-tasks-body">
				<section className="pensieve-tasks-section">
					<h3 className="pensieve-tasks-section-title">Registered workers ({data.workers.length})</h3>
					<p className="hint" style={{ margin: "0 0 8px" }}>
						Action types the agent's TaskService knows how to execute.
					</p>
					{data.workers.length === 0 ? (
						<div className="empty">No task workers registered.</div>
					) : (
						<div className="pensieve-task-worker-grid">
							{data.workers.map((w) => (
								<div key={w.name} className="pensieve-task-worker">
									<div className="pensieve-task-worker-name">{w.name}</div>
									<div className="hint">
										{w.hasShouldRun && <span className="badge muted">shouldRun</span>}{" "}
										{w.hasCanExecute && <span className="badge muted">canExecute</span>}
									</div>
								</div>
							))}
						</div>
					)}
				</section>

				<section className="pensieve-tasks-section">
					<h3 className="pensieve-tasks-section-title">Scheduled & autonomous tasks ({data.tasks.length})</h3>
					{data.tasks.length === 0 ? (
						<div className="empty">No tasks scheduled.</div>
					) : (
						<div className="pensieve-task-list">
							{data.tasks.map((t) => {
								const recurring = typeof t.updateInterval === "number";
								const orphaned = !t.hasWorker;
								return (
									<div
										key={t.id}
										className={`pensieve-task-row ${t.paused ? "paused" : ""} ${orphaned ? "orphaned" : ""}`}
									>
										<div className="pensieve-task-row-header">
											<span className="pensieve-task-name">{t.name}</span>
											{recurring ? (
												<span className="badge info">every {fmtInterval(t.updateInterval)}</span>
											) : (
												<span className="badge muted">one-shot</span>
											)}
											{t.paused && <span className="badge warn">paused</span>}
											{orphaned && <span className="badge err">no worker</span>}
											{t.failureCount > 0 && (
												<span className="badge err">{t.failureCount} fails</span>
											)}
											<span style={{ flex: 1 }} />
											<div className="pensieve-task-actions">
												<button
													type="button"
													className="link"
													disabled={busyId === t.id}
													onClick={() => act(t.id, "run")}
												>
													run now
												</button>
												{t.paused ? (
													<button
														type="button"
														className="link"
														disabled={busyId === t.id}
														onClick={() => act(t.id, "resume")}
													>
														resume
													</button>
												) : (
													<button
														type="button"
														className="link"
														disabled={busyId === t.id}
														onClick={() => act(t.id, "pause")}
													>
														pause
													</button>
												)}
												<button
													type="button"
													className="link danger"
													disabled={busyId === t.id}
													onClick={() => act(t.id, "delete")}
												>
													delete
												</button>
											</div>
										</div>
										{t.description && (
											<div className="pensieve-task-description">{t.description}</div>
										)}
										<div className="pensieve-task-meta">
											{t.tags.length > 0 && (
												<span className="hint">tags: {t.tags.join(", ")}</span>
											)}
											<span className="hint">last: {fmtTime(t.lastExecuted)}</span>
											{recurring && (
												<span className="hint">next: {fmtTime(t.nextRunAt)} ({fmtRelative(t.nextRunAt)})</span>
											)}
										</div>
										{t.lastError && (
											<div className="banner error" style={{ marginTop: 6, fontSize: 11 }}>{t.lastError}</div>
										)}
										<div className="pensieve-trajectory-id">{t.id}</div>
									</div>
								);
							})}
						</div>
					)}
				</section>
			</div>
		</div>
	);
}
