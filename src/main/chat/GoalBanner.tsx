import { type ReactElement, useEffect, useState } from "react";
import type { DetourGoalWire } from "../../shared/rpc/goals";
import { rpc } from "../rpc";
import { onGoalChanged } from "../rpc-listeners/goals";

/**
 * Active conversation goal — surfaced above chat so the user can see what
 * the agent committed to, edit it, or clear it. Matches QuotaBanner's slot
 * just below the top of `.chat-view`.
 *
 * Refresh strategy: hydrate from `goalsGetActive` on mount, then listen
 * for the `goalChanged` broadcast. Don't poll — goals only change on user
 * action or on the goal-service's lazy extraction (which broadcasts on
 * commit).
 */

function formatAge(createdAt: number): string {
	const seconds = Math.max(0, Math.round((Date.now() - createdAt) / 1000));
	if (seconds < 60) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.round(hours / 24);
	return `${days}d ago`;
}

export function GoalBanner(): ReactElement | null {
	const [goal, setGoal] = useState<DetourGoalWire | null>(null);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		let cancelled = false;
		void rpc.request.goalsGetActive({}).then((state) => {
			if (!cancelled) setGoal(state.goal);
		}).catch(() => { /* startup race */ });
		const off = onGoalChanged((payload) => {
			setGoal(payload.goal);
		});
		return () => {
			cancelled = true;
			off();
		};
	}, []);

	const startEdit = (): void => {
		setDraft(goal?.text ?? "");
		setEditing(true);
	};

	const save = async (): Promise<void> => {
		const text = draft.trim();
		if (!text) return;
		setBusy(true);
		try {
			const res = await rpc.request.goalsSetActive({ text });
			setGoal(res.goal);
			setEditing(false);
		} finally {
			setBusy(false);
		}
	};

	const clear = async (): Promise<void> => {
		setBusy(true);
		try {
			await rpc.request.goalsClear({});
			setGoal(null);
		} finally {
			setBusy(false);
		}
	};

	if (!goal && !editing) {
		return (
			<div className="goal-banner goal-banner-empty" role="status">
				<span className="goal-banner-icon" aria-hidden>
					◎
				</span>
				<span className="goal-banner-label">No active goal — first substantive turn will set one.</span>
				<button
					type="button"
					className="goal-banner-btn"
					onClick={startEdit}
					disabled={busy}
				>
					Set goal
				</button>
			</div>
		);
	}

	if (editing) {
		return (
			<div className="goal-banner goal-banner-edit" role="form">
				<span className="goal-banner-icon" aria-hidden>
					◎
				</span>
				<input
					type="text"
					className="goal-banner-input"
					placeholder="Imperative sentence, e.g. “Ship auth demo by EOD”"
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") void save();
						if (e.key === "Escape") setEditing(false);
					}}
					autoFocus
				/>
				<button
					type="button"
					className="goal-banner-btn primary"
					onClick={() => void save()}
					disabled={busy || draft.trim().length === 0}
				>
					Save
				</button>
				<button
					type="button"
					className="goal-banner-btn"
					onClick={() => setEditing(false)}
					disabled={busy}
				>
					Cancel
				</button>
			</div>
		);
	}

	if (!goal) return null;

	return (
		<div className="goal-banner" role="status">
			<span className="goal-banner-icon" aria-hidden>
				●
			</span>
			<span className="goal-banner-text">{goal.text}</span>
			<span className="goal-banner-meta">{formatAge(goal.createdAt)} · {goal.source}</span>
			<button
				type="button"
				className="goal-banner-btn"
				onClick={startEdit}
				disabled={busy}
				title="Edit the active goal"
			>
				Edit
			</button>
			<button
				type="button"
				className="goal-banner-btn"
				onClick={() => void clear()}
				disabled={busy}
				title="Clear the active goal"
			>
				Clear
			</button>
		</div>
	);
}
