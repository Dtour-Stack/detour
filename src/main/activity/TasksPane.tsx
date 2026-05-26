/**
 * Activity > Tasks pane.
 *
 * Surfaces elizaOS's TaskService — registered TaskWorkers (action types the
 * agent can do autonomously) plus persisted Tasks (recurring + one-shot)
 * with paused/failure/lastRun status. Per-row Run/Pause/Resume/Delete.
 */

import { useCallback, useState } from "react";
import type { ActivityTasksSnapshot } from "../../shared/index";
import { UI_POLL_INTERVAL_MS } from "../../shared/timing";
import { rpc } from "../rpc";
import { TaskRow } from "./task-row";
import { usePoller } from "./usePoller";

export function TasksPane() {
	const [busyId, setBusyId] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const fetcher = useCallback(() => rpc.request.activityTasksList({}), []);
	const { data, error, refresh } = usePoller<ActivityTasksSnapshot>(fetcher, UI_POLL_INTERVAL_MS.default);

	const act = useCallback(
		async (id: string, op: "run" | "pause" | "resume" | "delete") => {
			setBusyId(id);
			setActionError(null);
			try {
				if (op === "run") await rpc.request.activityTaskRun({ id });
				else if (op === "pause") await rpc.request.activityTaskPause({ id });
				else if (op === "resume") await rpc.request.activityTaskResume({ id });
				else if (op === "delete") {
					if (!confirm("Delete this task? This cannot be undone.")) return;
					await rpc.request.activityTaskDelete({ id });
				}
				refresh();
			} catch (e) {
				setActionError(e instanceof Error ? e.message : String(e));
			} finally {
				setBusyId(null);
			}
		},
		[refresh],
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
							{data.tasks.map((t) => (
								<TaskRow
									key={t.id}
									task={t}
									actions={
										<>
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
										</>
									}
								/>
							))}
						</div>
					)}
				</section>
			</div>
		</div>
	);
}
