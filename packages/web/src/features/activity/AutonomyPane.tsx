import { useCallback, useEffect, useState } from "react";
import type {
	ActivityAutonomySnapshot,
	ActivityAutonomyTask,
	ActivityXAutonomyHandled,
} from "@detour/shared";
import type { WebClient } from "../../api/client";
import { usePoller } from "./usePoller";

const PRESETS = [5_000, 15_000, 30_000, 60_000, 300_000];

function fmtTime(ts?: number): string {
	if (!ts) return "-";
	const ms = ts < 1e12 ? ts * 1000 : ts;
	return new Date(ms).toLocaleString();
}

function fmtRelative(ts?: number): string {
	if (!ts) return "-";
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
	if (!ms) return "-";
	if (ms < 1000) return "<1s";
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
	if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
	return `${Math.round(ms / 86_400_000)}d`;
}

function runnerLabel(runner: ActivityAutonomySnapshot["runner"]): string {
	if (runner === "prompt-batcher") return "prompt batcher";
	if (runner === "task") return "task loop";
	if (runner === "missing") return "missing runner";
	return "none";
}

function runnerTone(runner: ActivityAutonomySnapshot["runner"]): string {
	if (runner === "prompt-batcher" || runner === "task") return "ok";
	if (runner === "missing") return "err";
	return "muted";
}

function outcomeTone(item: ActivityXAutonomyHandled): string {
	if (item.success === true) return "ok";
	if (item.success === false || item.error) return "err";
	if (item.action.includes("skip") || item.action.includes("dry_run")) return "warn";
	return "muted";
}

function Metric({ label, value }: { label: string; value: string }) {
	return (
		<div className="autonomy-metric">
			<span>{label}</span>
			<strong>{value}</strong>
		</div>
	);
}

function TaskRow({ task }: { task: ActivityAutonomyTask }) {
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
				{task.failureCount > 0 && <span className="badge err">{task.failureCount} fails</span>}
			</div>
			{task.description && <div className="pensieve-task-description">{task.description}</div>}
			<div className="pensieve-task-meta">
				{task.tags.length > 0 && <span className="hint">tags: {task.tags.join(", ")}</span>}
				<span className="hint">last: {fmtTime(task.lastExecuted)}</span>
				{recurring && <span className="hint">next: {fmtTime(task.nextRunAt)} ({fmtRelative(task.nextRunAt)})</span>}
			</div>
			{task.lastError && <div className="banner error autonomy-inline-error">{task.lastError}</div>}
			<div className="pensieve-trajectory-id">{task.id}</div>
		</div>
	);
}

function HandledRow({ item }: { item: ActivityXAutonomyHandled }) {
	const detail = item.error ?? item.text ?? item.reason ?? item.resultTweetId ?? item.tweetId ?? "";
	return (
		<div className="autonomy-handled-row">
			<span className={`badge ${outcomeTone(item)}`}>{item.action}</span>
			{typeof item.success === "boolean" && (
				<span className={`badge ${item.success ? "ok" : "err"}`}>{item.success ? "success" : "failed"}</span>
			)}
			{item.authorScreenName && <span className="hint">@{item.authorScreenName}</span>}
			{item.query && <span className="hint">query {item.query}</span>}
			{typeof item.score === "number" && <span className="hint">score {item.score}</span>}
			{item.tweetId && <span className="hint">tweet {item.tweetId}</span>}
			{detail && <span className="hint autonomy-handled-detail">{detail}</span>}
		</div>
	);
}

function AutonomyToolbar({ data }: { data: ActivityAutonomySnapshot }) {
	return (
		<div className="pensieve-toolbar">
			<span className={`badge ${data.enabled ? "ok" : "muted"}`}>{data.enabled ? "enabled" : "disabled"}</span>
			<span className={`badge ${data.running ? "ok" : "muted"}`}>{data.running ? "running" : "idle"}</span>
			<span className={`badge ${runnerTone(data.runner)}`}>{runnerLabel(data.runner)}</span>
			{data.thinking && <span className="badge info">thinking</span>}
			<span className={`badge ${data.x.available ? "ok" : "muted"}`}>X {data.x.available ? "ready" : "missing"}</span>
			<span style={{ flex: 1 }} />
			<span className="hint">polling 3s</span>
		</div>
	);
}

function ContinuousThinkingSection({
	busy,
	data,
	onSetEnabled,
}: {
	busy: boolean;
	data: ActivityAutonomySnapshot;
	onSetEnabled: (on: boolean) => void;
}) {
	return (
		<section className="autonomy-section">
			<div className="autonomy-section-head">
				<h3 className="autonomy-title">Continuous Thinking</h3>
				<div className="row" style={{ gap: 8 }}>
					<button type="button" className="btn small" disabled={busy || data.enabled} onClick={() => onSetEnabled(true)}>
						Enable
					</button>
					<button type="button" className="btn small ghost" disabled={busy || !data.enabled} onClick={() => onSetEnabled(false)}>
						Disable
					</button>
				</div>
			</div>
			<div className="autonomy-metrics">
				<Metric label="Interval" value={fmtInterval(data.intervalMs)} />
				<Metric label="Runner" value={runnerLabel(data.runner)} />
				<Metric label="Room" value={data.autonomousRoomId ?? "-"} />
			</div>
		</section>
	);
}

function LoopIntervalSection({
	busy,
	data,
	draftInterval,
	onApply,
	onDraft,
}: {
	busy: boolean;
	data: ActivityAutonomySnapshot;
	draftInterval: number | null;
	onApply: (ms: number) => void;
	onDraft: (ms: number) => void;
}) {
	return (
		<section className="autonomy-section">
			<div className="autonomy-section-head">
				<h3 className="autonomy-title">Loop Interval</h3>
				<div className="row" style={{ gap: 4 }}>
					{PRESETS.map((ms) => (
						<button
							key={ms}
							type="button"
							className={`btn small ${draftInterval === ms ? "" : "ghost"}`}
							disabled={busy}
							onClick={() => onDraft(ms)}
						>
							{fmtInterval(ms)}
						</button>
					))}
				</div>
			</div>
			<div className="row" style={{ gap: 6 }}>
				<input
					type="number"
					min={5}
					max={600}
					step={5}
					value={Math.round((draftInterval ?? data.intervalMs) / 1000)}
					onChange={(e) => onDraft(Number(e.target.value) * 1000)}
					className="pensieve-input"
					style={{ width: 100 }}
				/>
				<span className="hint">seconds</span>
				<button
					type="button"
					className="btn small"
					disabled={busy || draftInterval === null || draftInterval === data.intervalMs}
					onClick={() => draftInterval !== null && onApply(draftInterval)}
				>
					Apply
				</button>
			</div>
		</section>
	);
}

function WorkersSection({ tasks }: { tasks: ActivityAutonomyTask[] }) {
	return (
		<section className="autonomy-section">
			<div className="autonomy-section-head">
				<h3 className="autonomy-title">Autonomous Workers</h3>
				<span className="badge muted">{tasks.length} tasks</span>
			</div>
			{tasks.length === 0 ? (
				<div className="empty">No autonomous workers are scheduled.</div>
			) : (
				<div className="pensieve-task-list">
					{tasks.map((task) => <TaskRow key={task.id} task={task} />)}
				</div>
			)}
		</section>
	);
}

function XBadges({ x }: { x: ActivityAutonomySnapshot["x"] }) {
	return (
		<div className="row" style={{ gap: 4 }}>
			<span className={`badge ${x.enabled ? "ok" : "muted"}`}>{x.enabled ? "enabled" : "disabled"}</span>
			<span className={`badge ${x.writeEnabled ? "ok" : "warn"}`}>{x.writeEnabled ? "write on" : "dry run"}</span>
			<span className={`badge ${x.statusPostingEnabled ? "ok" : "muted"}`}>status {x.statusPostingEnabled ? "on" : "off"}</span>
			<span className={`badge ${x.discoveryEnabled ? "ok" : "muted"}`}>discovery {x.discoveryEnabled ? "on" : "off"}</span>
			<span className={`badge ${x.proactiveEngagementEnabled ? "ok" : "muted"}`}>proactive {x.proactiveEngagementEnabled ? "on" : "dry"}</span>
			<span className={`badge ${x.followEnabled ? "ok" : "muted"}`}>follow {x.followEnabled ? "on" : "off"}</span>
		</div>
	);
}

function XMetrics({ x }: { x: ActivityAutonomySnapshot["x"] }) {
	return (
		<div className="autonomy-metrics">
			<Metric label="Notify loop" value={fmtInterval(x.intervalMs)} />
			<Metric label="Status loop" value={fmtInterval(x.statusIntervalMs)} />
			<Metric label="Discovery loop" value={fmtInterval(x.discoveryIntervalMs)} />
			<Metric label="Last run" value={fmtTime(x.lastRunAt)} />
			<Metric label="Last status" value={fmtTime(x.lastStatusAt)} />
			<Metric label="Last discovery" value={fmtTime(x.lastDiscoveryAt)} />
			<Metric label="Last tweet" value={x.lastStatusTweetId ?? "-"} />
			<Metric label="Handled" value={String(x.lastHandledCount)} />
			<Metric label="Discover max" value={String(x.maxDiscoveryPerTick)} />
		</div>
	);
}

function XAutonomySection({ data }: { data: ActivityAutonomySnapshot }) {
	return (
		<section className="autonomy-section">
			<div className="autonomy-section-head">
				<h3 className="autonomy-title">X Autonomy</h3>
				<XBadges x={data.x} />
			</div>
			<XMetrics x={data.x} />
			{data.x.discoveryQueries.length > 0 && (
				<div className="hint autonomy-query-list">queries: {data.x.discoveryQueries.join(", ")}</div>
			)}
			{data.x.lastHandled.length > 0 ? (
				<div className="autonomy-handled-list">
					{data.x.lastHandled.map((item, i) => <HandledRow key={`${item.action}-${i}`} item={item} />)}
				</div>
			) : (
				<div className="empty autonomy-empty-inline">No recent X actions.</div>
			)}
		</section>
	);
}

function ImprovementSection({ data }: { data: ActivityAutonomySnapshot }) {
	const improvement = data.improvement;
	return (
		<section className="autonomy-section">
			<div className="autonomy-section-head">
				<h3 className="autonomy-title">Continuous Improvement</h3>
				<div className="row" style={{ gap: 4 }}>
					<span className={`badge ${improvement.available ? "ok" : "muted"}`}>
						{improvement.available ? "ready" : "missing"}
					</span>
					<span className={`badge ${improvement.enabled ? "ok" : "muted"}`}>
						{improvement.enabled ? "enabled" : "disabled"}
					</span>
				</div>
			</div>
			<div className="autonomy-metrics">
				<Metric label="Loop" value={fmtInterval(improvement.intervalMs)} />
				<Metric label="Last run" value={fmtTime(improvement.lastRunAt)} />
				<Metric label="Result" value={improvement.lastResult ?? "-"} />
				<Metric label="Category" value={improvement.lastCategory ?? "-"} />
				<Metric label="Memories" value={String(improvement.lastMemoryIds.length)} />
				<Metric label="Error" value={improvement.lastError ?? "-"} />
			</div>
			{improvement.lastProposal ? (
				<div className="hint autonomy-query-list">{improvement.lastProposal}</div>
			) : (
				<div className="empty autonomy-empty-inline">No improvement reflection yet.</div>
			)}
		</section>
	);
}

export function AutonomyPane({ client }: { client: WebClient }) {
	const fetcher = useCallback(() => client.activityAutonomy(), [client]);
	const { data, error, refresh } = usePoller<ActivityAutonomySnapshot>(fetcher, 3000);
	const [busy, setBusy] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const [draftInterval, setDraftInterval] = useState<number | null>(null);

	useEffect(() => {
		if (data && draftInterval === null) setDraftInterval(data.intervalMs);
	}, [data, draftInterval]);

	const setEnabled = useCallback(async (on: boolean) => {
		setBusy(true);
		setActionError(null);
		try {
			await client.activitySetAutonomy(on);
			refresh();
		} catch (e) {
			setActionError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}, [client, refresh]);

	const applyInterval = useCallback(async (ms: number) => {
		setBusy(true);
		setActionError(null);
		try {
			await client.activitySetAutonomyInterval(ms);
			setDraftInterval(ms);
			refresh();
		} catch (e) {
			setActionError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}, [client, refresh]);

	if (error) return <div className="banner error">{error}</div>;
	if (!data) return <div className="empty">Loading autonomy state...</div>;
	if (!data.available) {
		return (
			<div className="empty" style={{ margin: 24 }}>
				AutonomyService is not loaded into this runtime.
			</div>
		);
	}

	return (
		<div className="autonomy-pane">
			<AutonomyToolbar data={data} />
			{actionError && <div className="banner error" style={{ margin: "8px 18px 0" }}>{actionError}</div>}
			<div className="autonomy-body">
				<ContinuousThinkingSection busy={busy} data={data} onSetEnabled={(on) => void setEnabled(on)} />
				<LoopIntervalSection
					busy={busy}
					data={data}
					draftInterval={draftInterval}
					onApply={(ms) => void applyInterval(ms)}
					onDraft={setDraftInterval}
				/>
				<WorkersSection tasks={data.tasks} />
				<XAutonomySection data={data} />
				<ImprovementSection data={data} />
			</div>
		</div>
	);
}
