import { useCallback, useEffect, useState } from "react";
import type {
	ActivityAutonomySnapshot,
	ActivityAutonomyTask,
	ActivityXAutonomyHandled,
	ActivityXAutonomyUpdate,
} from "@detour/shared";
import type { WebClient } from "../_shared/api/client";
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
					onChange={(e) => {
						const seconds = Number(e.target.value);
						const clamped = Number.isFinite(seconds) ? Math.max(5, Math.min(600, seconds)) : 5;
						onDraft(clamped * 1000);
					}}
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
			<Metric label="Reply max" value={String(x.maxRepliesPerTick)} />
			<Metric label="Discover max" value={String(x.maxDiscoveryPerTick)} />
		</div>
	);
}

type XDraft = {
	intervalSeconds: number;
	statusMinutes: number;
	discoveryMinutes: number;
	maxRepliesPerTick: number;
	maxDiscoveryPerTick: number;
	discoveryQueries: string;
};

function xDraftFrom(data: ActivityAutonomySnapshot["x"]): XDraft {
	return {
		intervalSeconds: Math.round(data.intervalMs / 1000),
		statusMinutes: Math.round(data.statusIntervalMs / 60_000),
		discoveryMinutes: Math.round(data.discoveryIntervalMs / 60_000),
		maxRepliesPerTick: data.maxRepliesPerTick,
		maxDiscoveryPerTick: data.maxDiscoveryPerTick,
		discoveryQueries: data.discoveryQueries.join("\n"),
	};
}

function parseQueries(value: string): string[] {
	return value
		.split(/[\n,]+/)
		.map((item) => item.trim())
		.filter((item) => item.length > 0)
		.slice(0, 12);
}

function XToggle({
	label,
	value,
	disabled,
	onChange,
}: {
	label: string;
	value: boolean;
	disabled: boolean;
	onChange: () => void;
}) {
	return (
		<div className="autonomy-toggle-row">
			<span>{label}</span>
			<button
				type="button"
				className={`channel-toggle ${value ? "on" : "off"}`}
				disabled={disabled}
				onClick={onChange}
				aria-label={`${value ? "Disable" : "Enable"} ${label}`}
				title={`${value ? "Disable" : "Enable"} ${label}`}
			>
				<span className="channel-toggle-knob" />
			</button>
		</div>
	);
}

function XNumberInput({
	label,
	value,
	min,
	max,
	step,
	onChange,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	step: number;
	onChange: (value: number) => void;
}) {
	return (
		<label className="autonomy-setting-field">
			<span>{label}</span>
			<input
				type="number"
				min={min}
				max={max}
				step={step}
				value={value}
				onChange={(e) => {
					const n = Number(e.target.value);
					if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)));
				}}
				className="pensieve-input"
			/>
		</label>
	);
}

function XAutonomySection({
	client,
	data,
	onChanged,
}: {
	client: WebClient;
	data: ActivityAutonomySnapshot;
	onChanged: () => void;
}) {
	const [draft, setDraft] = useState<XDraft>(() => xDraftFrom(data.x));
	const [dirty, setDirty] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!dirty) setDraft(xDraftFrom(data.x));
	}, [data.x, dirty]);

	const apply = useCallback(async (update: ActivityXAutonomyUpdate, resetDirty = false) => {
		setSaving(true);
		setError(null);
		try {
			await client.activitySetXAutonomy(update);
			if (resetDirty) setDirty(false);
			onChanged();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	}, [client, onChanged]);

	const saveDraft = useCallback(() => {
		void apply({
			intervalMs: draft.intervalSeconds * 1000,
			statusIntervalMs: draft.statusMinutes * 60_000,
			discoveryIntervalMs: draft.discoveryMinutes * 60_000,
			maxRepliesPerTick: draft.maxRepliesPerTick,
			maxDiscoveryPerTick: draft.maxDiscoveryPerTick,
			discoveryQueries: parseQueries(draft.discoveryQueries),
		}, true);
	}, [apply, draft]);

	const editDraft = useCallback((patch: Partial<XDraft>) => {
		setDirty(true);
		setDraft((current) => ({ ...current, ...patch }));
	}, []);

	return (
		<section className="autonomy-section">
			<div className="autonomy-section-head">
				<h3 className="autonomy-title">X Autonomy</h3>
				<XBadges x={data.x} />
			</div>
			<XMetrics x={data.x} />
			{error && <div className="banner error autonomy-inline-error">{error}</div>}
			<div className="autonomy-toggle-grid">
				<XToggle label="Autonomy" value={data.x.enabled} disabled={saving} onChange={() => void apply({ enabled: !data.x.enabled })} />
				<XToggle label="Writes" value={data.x.writeEnabled} disabled={saving} onChange={() => void apply({ writeEnabled: !data.x.writeEnabled })} />
				<XToggle label="Status posts" value={data.x.statusPostingEnabled} disabled={saving} onChange={() => void apply({ statusPostingEnabled: !data.x.statusPostingEnabled })} />
				<XToggle label="Discovery" value={data.x.discoveryEnabled} disabled={saving} onChange={() => void apply({ discoveryEnabled: !data.x.discoveryEnabled })} />
				<XToggle label="Proactive replies" value={data.x.proactiveEngagementEnabled} disabled={saving} onChange={() => void apply({ proactiveEngagementEnabled: !data.x.proactiveEngagementEnabled })} />
				<XToggle label="Follows" value={data.x.followEnabled} disabled={saving} onChange={() => void apply({ followEnabled: !data.x.followEnabled })} />
			</div>
			<div className="autonomy-settings-grid">
				<XNumberInput label="Notify seconds" min={30} max={1800} step={30} value={draft.intervalSeconds} onChange={(value) => editDraft({ intervalSeconds: value })} />
				<XNumberInput label="Status minutes" min={15} max={1440} step={15} value={draft.statusMinutes} onChange={(value) => editDraft({ statusMinutes: value })} />
				<XNumberInput label="Discovery minutes" min={5} max={1440} step={5} value={draft.discoveryMinutes} onChange={(value) => editDraft({ discoveryMinutes: value })} />
				<XNumberInput label="Replies per tick" min={1} max={5} step={1} value={draft.maxRepliesPerTick} onChange={(value) => editDraft({ maxRepliesPerTick: value })} />
				<XNumberInput label="Discover per tick" min={0} max={8} step={1} value={draft.maxDiscoveryPerTick} onChange={(value) => editDraft({ maxDiscoveryPerTick: value })} />
			</div>
			<label className="autonomy-setting-field">
				<span>Discovery queries</span>
				<textarea
					className="pensieve-input autonomy-query-input"
					value={draft.discoveryQueries}
					onChange={(e) => editDraft({ discoveryQueries: e.target.value })}
				/>
			</label>
			<div className="row" style={{ gap: 8 }}>
				<button type="button" className="btn small" disabled={saving || !dirty} onClick={saveDraft}>
					{saving ? "Saving..." : "Save X settings"}
				</button>
				{dirty && <button type="button" className="btn small ghost" disabled={saving} onClick={() => { setDraft(xDraftFrom(data.x)); setDirty(false); }}>Reset</button>}
			</div>
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
				<XAutonomySection client={client} data={data} onChanged={refresh} />
				<ImprovementSection data={data} />
			</div>
		</div>
	);
}
