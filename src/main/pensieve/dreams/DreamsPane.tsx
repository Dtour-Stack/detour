import { type ReactElement, useCallback, useEffect, useState } from "react";
import type { DreamSummary } from "../../../shared/rpc/dreams";
import { rpc } from "../../rpc";
import { onDreamChanged } from "../../rpc-listeners/dreams";

/**
 * Dreams pane — lists past memory-consolidation runs. Each card surfaces
 * the LLM's notes summary, the proposed diff counts (additions / merges /
 * replacements / deletions), and per-dream Apply / Reject buttons that
 * commit-or-discard the staged changes.
 *
 * "Run dream now" triggers a manual pass via DreamService.runNow — useful
 * when iterating on memory hygiene without waiting for the 6h scheduler.
 */

function formatTime(ms: number): string {
	if (!ms) return "(unknown)";
	const date = new Date(ms);
	return date.toLocaleString();
}

export function DreamsPane(): ReactElement {
	const [dreams, setDreams] = useState<DreamSummary[]>([]);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async (): Promise<void> => {
		try {
			const result = await rpc.request.dreamsList({});
			setDreams(result.dreams);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
		const off = onDreamChanged((payload) => {
			setDreams(payload.dreams);
		});
		return () => {
			off();
		};
	}, [refresh]);

	const runNow = async (): Promise<void> => {
		setBusy("__run__");
		setError(null);
		try {
			const res = await rpc.request.dreamsRunNow({});
			if (res.skipReason && !res.planId) {
				setError(`Skipped: ${res.skipReason}`);
			}
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	};

	const apply = async (dreamId: string): Promise<void> => {
		setBusy(dreamId);
		try {
			await rpc.request.dreamsApply({ dreamId });
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	};

	const reject = async (dreamId: string): Promise<void> => {
		setBusy(dreamId);
		try {
			await rpc.request.dreamsReject({ dreamId });
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	};

	return (
		<div className="dreams-pane">
			<div className="dreams-pane-header">
				<h2>Dreams — Pensieve memory consolidation</h2>
				<button
					type="button"
					className="btn"
					onClick={() => void runNow()}
					disabled={busy !== null}
				>
					{busy === "__run__" ? "Running…" : "Run dream now"}
				</button>
			</div>
			{error && (
				<div className="banner error">{error}</div>
			)}
			{loading ? (
				<div className="dreams-empty">Loading dreams…</div>
			) : dreams.length === 0 ? (
				<div className="dreams-empty">
					No dreams yet. They run automatically every ~6 hours, or trigger one now to
					consolidate memories from recent sessions.
				</div>
			) : (
				dreams.map((dream) => (
					<div key={dream.id} className="dream-card">
						<div className="dream-card-head">
							<strong>{dream.summary || "(no summary)"}</strong>
							<span className="dream-card-time">{formatTime(dream.createdAt)}</span>
						</div>
						{dream.notes && <div className="dream-card-notes">{dream.notes}</div>}
						<div className="dream-card-counts">
							<span>+ {dream.counts.additions ?? 0} add</span>
							<span>~ {dream.counts.merges ?? 0} merge</span>
							<span>* {dream.counts.replacements ?? 0} replace</span>
							<span>- {dream.counts.deletions ?? 0} delete</span>
							<span>· {dream.pendingCount} pending</span>
						</div>
						<div className="dream-card-actions">
							<button
								type="button"
								className="btn primary"
								onClick={() => void apply(dream.id)}
								disabled={busy !== null || dream.pendingCount === 0}
							>
								{busy === dream.id ? "Applying…" : "Apply all"}
							</button>
							<button
								type="button"
								className="btn"
								onClick={() => void reject(dream.id)}
								disabled={busy !== null || dream.pendingCount === 0}
							>
								Reject
							</button>
						</div>
					</div>
				))
			)}
		</div>
	);
}
