/**
 * Activity > Autonomy pane.
 *
 * Wraps eliza's AutonomyService — toggle continuous-thinking on/off, set the
 * loop interval (5s–10m), see the last-thought / next-scheduled state.
 */

import { useCallback, useEffect, useState } from "react";
import type { ActivityAutonomySnapshot } from "@detour/shared";
import type { WebClient } from "../../api/client";
import { usePoller } from "./usePoller";

const PRESETS = [5_000, 15_000, 30_000, 60_000, 300_000];

function fmtInterval(ms: number): string {
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
	return `${(ms / 3_600_000).toFixed(1)}h`;
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
	if (!data) return <div className="empty">Loading autonomy state…</div>;
	if (!data.available) {
		return (
			<div className="empty" style={{ margin: 24 }}>
				AutonomyService isn't loaded into this runtime. Send a chat to warm the agent first; if the issue persists, the autonomy plugin may not be enabled.
			</div>
		);
	}

	return (
		<div className="autonomy-pane">
			<div className="pensieve-toolbar">
				<span className="badge muted">{data.enabled ? "ENABLED" : "DISABLED"}</span>
				<span className={`badge ${data.running ? "ok" : "muted"}`}>
					{data.running ? "running" : "idle"}
				</span>
				{data.thinking && <span className="badge info">thinking…</span>}
				<span style={{ flex: 1 }} />
				<span className="hint">interval {fmtInterval(data.intervalMs)}</span>
			</div>

			{actionError && <div className="banner error" style={{ margin: "8px 18px 0" }}>{actionError}</div>}

			<div className="autonomy-body">
				<section className="autonomy-section">
					<h3 className="autonomy-title">Continuous thinking</h3>
					<p className="hint" style={{ margin: "0 0 12px" }}>
						When enabled, the agent's prompt batcher fires the autonomy section on each tick — the agent thinks
						and may take actions without user input.
					</p>
					<div className="row" style={{ gap: 8 }}>
						<button
							type="button"
							className="btn small"
							disabled={busy || data.enabled}
							onClick={() => setEnabled(true)}
						>
							Enable
						</button>
						<button
							type="button"
							className="btn small ghost"
							disabled={busy || !data.enabled}
							onClick={() => setEnabled(false)}
						>
							Disable
						</button>
					</div>
				</section>

				<section className="autonomy-section">
					<h3 className="autonomy-title">Loop interval</h3>
					<p className="hint" style={{ margin: "0 0 12px" }}>
						How often the autonomy section ticks. Range 5s–10m. Lower = more reactive, higher = more cost-efficient.
					</p>
					<div className="row" style={{ gap: 4, marginBottom: 12 }}>
						{PRESETS.map((ms) => (
							<button
								key={ms}
								type="button"
								className={`btn small ${draftInterval === ms ? "" : "ghost"}`}
								disabled={busy}
								onClick={() => setDraftInterval(ms)}
							>
								{fmtInterval(ms)}
							</button>
						))}
					</div>
					<div className="row" style={{ gap: 6 }}>
						<input
							type="number"
							min={5}
							max={600}
							step={5}
							value={Math.round((draftInterval ?? data.intervalMs) / 1000)}
							onChange={(e) => setDraftInterval(Number(e.target.value) * 1000)}
							className="pensieve-input"
							style={{ width: 100 }}
						/>
						<span className="hint">seconds</span>
						<button
							type="button"
							className="btn small"
							disabled={busy || draftInterval === null || draftInterval === data.intervalMs}
							onClick={() => draftInterval !== null && applyInterval(draftInterval)}
						>
							Apply
						</button>
					</div>
				</section>

				{data.autonomousRoomId && (
					<section className="autonomy-section">
						<h3 className="autonomy-title">Autonomous room</h3>
						<div className="pensieve-trajectory-id">{data.autonomousRoomId}</div>
						<p className="hint" style={{ margin: "8px 0 0" }}>
							Memories generated by autonomous turns get scoped to this room — separate from your interactive chat.
						</p>
					</section>
				)}
			</div>
		</div>
	);
}
