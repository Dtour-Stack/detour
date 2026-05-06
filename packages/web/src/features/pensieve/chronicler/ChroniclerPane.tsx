import { useCallback, useState } from "react";
import type { ChroniclerConfig, ChroniclerObservation, ChroniclerStatus } from "@detour/shared";
import type { WebClient } from "../../../api/client";
import { usePoller } from "../usePoller";

interface ChroniclerData {
	status: ChroniclerStatus;
	recent: ChroniclerObservation[];
}

export function ChroniclerPane({ client }: { client: WebClient }) {
	const [busy, setBusy] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const fetcher = useCallback(async (): Promise<ChroniclerData> => {
		const [status, recent] = await Promise.all([
			client.pensieveChroniclerStatus(),
			client.pensieveChroniclerRecent(20),
		]);
		return { status, recent };
	}, [client]);
	const { data, error, loading, refresh } = usePoller<ChroniclerData>(fetcher, 5000, []);
	const status = data?.status;

	const updateConfig = useCallback(async (patch: Partial<ChroniclerConfig>) => {
		setBusy(true);
		setActionError(null);
		try {
			await client.pensieveSetChroniclerConfig(patch);
			refresh();
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}, [client, refresh]);

	const sampleNow = useCallback(async () => {
		setBusy(true);
		setActionError(null);
		try {
			await client.pensieveChroniclerSample();
			refresh();
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}, [client, refresh]);

	return (
		<div className="chronicler-pane">
			<div className="pensieve-toolbar">
				<span className={`badge ${status?.running ? "ok" : status?.enabled ? "warn" : "muted"}`}>
					{status?.running ? "running" : status?.enabled ? "waiting" : "paused"}
				</span>
				<label className="pensieve-toolbar-toggle">
					<input
						type="checkbox"
						checked={!!status?.enabled}
						disabled={busy || !status?.available}
						onChange={(e) => void updateConfig({ enabled: e.target.checked })}
					/>
					Enabled
				</label>
				<button
					type="button"
					className="btn small ghost"
					disabled={busy || !status?.available}
					onClick={() => void sampleNow()}
				>
					Sample now
				</button>
				<span className="hint" style={{ marginLeft: "auto" }}>
					{loading ? "loading" : status?.lastSampleAt ? new Date(status.lastSampleAt).toLocaleTimeString() : "no samples"}
				</span>
			</div>

			{(error || actionError || status?.lastError) && (
				<div className="banner error chronicler-banner">
					{actionError ?? error ?? status?.lastError}
				</div>
			)}

			<div className="chronicler-content">
				<section className="chronicler-settings">
					<div className="chronicler-setting-row">
						<label>Interval</label>
						<select
							value={status?.intervalMs ?? 60_000}
							className="pensieve-select"
							disabled={busy || !status}
							onChange={(e) => void updateConfig({ intervalMs: Number(e.target.value) })}
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
							onChange={(e) => void updateConfig({ includeWindowTitles: e.target.checked })}
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
							onChange={(e) => void updateConfig({ maxWindowsPerScreen: Number(e.target.value) })}
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

				<section className="chronicler-recent">
					<div className="chronicler-section-title">Recent</div>
					{data?.recent.map((observation) => (
						<ObservationRow key={observation.id} observation={observation} />
					))}
					{data && data.recent.length === 0 && (
						<div className="empty">No chronicler observations yet.</div>
					)}
				</section>
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
