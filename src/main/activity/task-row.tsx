/**
 * Shared TaskRow + time-formatting helpers used by TasksPane and
 * AutonomyPane. Both panes render the same elizaOS-style task block;
 * keeping this in one place avoids two slightly-out-of-sync copies of
 * the badge logic, recurring-interval check, and meta line.
 *
 * The row is "render data + optional actions slot": TasksPane passes
 * run/pause/resume/delete buttons; AutonomyPane omits actions for a
 * read-only view.
 */

import type { ReactNode } from "react";

export function fmtTime(ts?: number): string {
	if (!ts) return "—";
	const ms = ts < 1e12 ? ts * 1000 : ts;
	return new Date(ms).toLocaleString();
}

export function fmtRelative(ts?: number): string {
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

export function fmtInterval(ms?: number): string {
	if (!ms) return "—";
	if (ms < 1000) return "<1s";
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
	if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
	return `${Math.round(ms / 86_400_000)}d`;
}

/**
 * Shape both `ActivityTaskRecord` (TasksPane) and `ActivityAutonomyTask`
 * (AutonomyPane) satisfy. Optional fields stay optional here so callers
 * can pass either record without conversion.
 */
export type TaskRowData = {
	id: string;
	name: string;
	description?: string;
	tags: string[];
	updateInterval?: number;
	nextRunAt?: number;
	lastExecuted?: number;
	lastError?: string;
	failureCount: number;
	paused: boolean;
	hasWorker: boolean;
};

export function TaskRow({
	task,
	actions,
}: {
	task: TaskRowData;
	actions?: ReactNode;
}) {
	const recurring = typeof task.updateInterval === "number";
	const orphaned = !task.hasWorker;
	return (
		<div className={`pensieve-task-row ${task.paused ? "paused" : ""} ${orphaned ? "orphaned" : ""}`}>
			<div className="pensieve-task-row-header">
				<span className="pensieve-task-name">{task.name}</span>
				{recurring ? (
					<span className="badge info">every {fmtInterval(task.updateInterval)}</span>
				) : (
					<span className="badge muted">one-shot</span>
				)}
				{task.paused && <span className="badge warn">paused</span>}
				{orphaned && <span className="badge err">no worker</span>}
				{task.failureCount > 0 && (
					<span className="badge err">{task.failureCount} fails</span>
				)}
				{actions && (
					<>
						<span style={{ flex: 1 }} />
						<div className="pensieve-task-actions">{actions}</div>
					</>
				)}
			</div>
			{task.description && (
				<div className="pensieve-task-description">{task.description}</div>
			)}
			<div className="pensieve-task-meta">
				{task.tags.length > 0 && (
					<span className="hint">tags: {task.tags.join(", ")}</span>
				)}
				<span className="hint">last: {fmtTime(task.lastExecuted)}</span>
				{recurring && (
					<span className="hint">next: {fmtTime(task.nextRunAt)} ({fmtRelative(task.nextRunAt)})</span>
				)}
			</div>
			{task.lastError && (
				<div className="banner error" style={{ marginTop: 6, fontSize: 11 }}>{task.lastError}</div>
			)}
			<div className="pensieve-trajectory-id">{task.id}</div>
		</div>
	);
}
