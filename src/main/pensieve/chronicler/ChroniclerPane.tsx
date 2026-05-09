import { useCallback, useState } from "react";
import type { ChroniclerConfig, ChroniclerObservation, ChroniclerStatus } from "../../../shared/index";
import type { WebClient } from "../../api/client";
import { rpc } from "../../rpc";
import { usePoller } from "../usePoller";

interface ChroniclerData {
	status: ChroniclerStatus;
	recent: ChroniclerObservation[];
}

function ChroniclerToolbar({
	busy,
	loading,
	onConfig,
	onSample,
	status,
}: {
	busy: boolean;
	loading: boolean;
	onConfig: (patch: Partial<ChroniclerConfig>) => void;
	onSample: () => void;
	status: ChroniclerStatus | undefined;
}) {
	return (
		<div className="pensieve-toolbar">
			<span className={`badge ${status?.running ? "ok" : status?.enabled ? "warn" : "muted"}`}>
				{status?.running ? "running" : status?.enabled ? "waiting" : "paused"}
			</span>
			<label className="pensieve-toolbar-toggle">
				<input
					type="checkbox"
					checked={!!status?.enabled}
					disabled={busy || !status?.available}
					onChange={(e) => onConfig({ enabled: e.target.checked })}
				/>
				Enabled
			</label>
			<button type="button" className="btn small ghost" disabled={busy || !status?.available} onClick={onSample}>
				Sample now
			</button>
			<span className="hint" style={{ marginLeft: "auto" }}>
				{loading ? "loading" : status?.lastSampleAt ? new Date(status.lastSampleAt).toLocaleTimeString() : "no samples"}
			</span>
		</div>
	);
}

function ChroniclerSettings({
	busy,
	onConfig,
	status,
}: {
	busy: boolean;
	onConfig: (patch: Partial<ChroniclerConfig>) => void;
	status: ChroniclerStatus | undefined;
}) {
	return (
		<section className="chronicler-settings">
			<div className="chronicler-setting-row">
				<label>Interval</label>
				<select
					value={status?.intervalMs ?? 60_000}
					className="pensieve-select"
					disabled={busy || !status}
					onChange={(e) => onConfig({ intervalMs: Number(e.target.value) })}
				>
					<option value={15000}>15s</option>
					<option value={30000}>30s</option>
					<option value={60000}>1m</option>
					<option value={300000}>5m</option>
					<option value={600000}>10m</option>
				</select>
			</div>
			<div className="chronicler-setting-row">
				<label>Window titles</label>
				<input
					type="checkbox"
					checked={!!status?.includeWindowTitles}
					disabled={busy || !status}
					onChange={(e) => onConfig({ includeWindowTitles: e.target.checked })}
				/>
			</div>
			<div className="chronicler-setting-row">
				<label>Windows per screen</label>
				<input
					type="number"
					min={1}
					max={30}
					value={status?.maxWindowsPerScreen ?? 8}
					disabled={busy || !status}
					onChange={(e) => onConfig({ maxWindowsPerScreen: Number(e.target.value) })}
				/>
			</div>
			<div className="chronicler-metrics">
				<div>
					<span className="hint">Path</span>
					<strong>{status?.pensievePath ?? "/observations/user-activity"}</strong>
				</div>
				<div>
					<span className="hint">Screens</span>
					<strong>{status?.screenCount ?? 0}</strong>
				</div>
				<div>
					<span className="hint">Windows</span>
					<strong>{status?.windowCount ?? 0}</strong>
				</div>
			</div>
		</section>
	);
}

function ChroniclerRecent({ observations }: { observations: ChroniclerObservation[] | undefined }) {
	return (
		<section className="chronicler-recent">
			<div className="chronicler-section-title">Recent</div>
			{observations?.map((observation) => (
				<ObservationRow key={observation.id} observation={observation} />
			))}
			{observations && observations.length === 0 && (
				<div className="empty">No chronicler observations yet.</div>
			)}
		</section>
	);
}

export function ChroniclerPane({ client }: { client: WebClient }) {
	const [busyCount, setBusyCount] = useState(0);
	const [actionError, setActionError] = useState<string | null>(null);
	const fetcher = useCallback(async (): Promise<ChroniclerData> => {
		const [status, recent] = await Promise.all([
			rpc.request.pensieveChroniclerStatus({}),
			rpc.request.pensieveChroniclerRecent({ limit: 20 }),
		]);
		return { status, recent };
	}, [client]);
	const { data, error, loading, refresh } = usePoller<ChroniclerData>(fetcher, 5000, []);
	const status = data?.status;
	const busy = busyCount > 0;
	const errors = [error, actionError, status?.lastError].filter((value): value is string => !!value);

	const updateConfig = useCallback(async (patch: Partial<ChroniclerConfig>) => {
		setBusyCount((count) => count + 1);
		setActionError(null);
		try {
			await rpc.request.pensieveChroniclerSetConfig(patch);
			refresh();
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusyCount((count) => Math.max(0, count - 1));
		}
	}, [client, refresh]);

	const sampleNow = useCallback(async () => {
		setBusyCount((count) => count + 1);
		setActionError(null);
		try {
			await rpc.request.pensieveChroniclerSample({});
			refresh();
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusyCount((count) => Math.max(0, count - 1));
		}
	}, [client, refresh]);

	return (
		<div className="chronicler-pane">
			<ChroniclerToolbar
				busy={busy}
				loading={loading}
				onConfig={(patch) => void updateConfig(patch)}
				onSample={() => void sampleNow()}
				status={status}
			/>
			{errors.length > 0 && (
				<div className="banner error chronicler-banner">
					{errors.join(" | ")}
				</div>
			)}

			<div className="chronicler-content">
				<ChroniclerSettings busy={busy} onConfig={(patch) => void updateConfig(patch)} status={status} />
				<ChroniclerRecent observations={data?.recent} />
			</div>
		</div>
	);
}

function ObservationRow({ observation }: { observation: ChroniclerObservation }) {
	return (
		<div className="chronicler-observation">
			<div className="chronicler-observation-head">
				<strong>{new Date(observation.ts).toLocaleString()}</strong>
				<span className="hint">{observation.windowCount} windows</span>
			</div>
			<div className="chronicler-summary">{observation.summary}</div>
			<div className="chronicler-screens">
				{observation.screens.map((screen) => (
					<div key={screen.id} className="chronicler-screen">
						<div className="chronicler-screen-title">Screen {screen.id}</div>
						{screen.windows.map((win, index) => (
							<div key={`${win.app}-${win.title ?? ""}-${index}`} className="chronicler-window">
								<span className={win.focused ? "badge info" : "badge muted"}>{win.app}</span>
								{win.title && <span className="chronicler-window-title">{win.title}</span>}
							</div>
						))}
					</div>
				))}
			</div>
		</div>
	);
}
