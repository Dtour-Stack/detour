/**
 * Activity > Subagents pane.
 *
 * Live list of PTY-spawned coding subagents (Codex / Claude Code /
 * OpenCode / Pi etc.) launched via the orchestrator's CREATE_TASK action.
 * Backed by `tasksList` RPC; per-row Tail / Send / Stop controls.
 *
 * If the orchestrator plugin isn't loaded (PTY_SERVICE absent), tasksList
 * returns an empty list and the pane shows the "no subagents running"
 * empty state. The tab still renders fine.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../rpc";
import { usePoller } from "./usePoller";
import type { TaskRow } from "../../shared/rpc/tasks";

function fmtRelative(iso: string): string {
	if (!iso) return "—";
	const ms = new Date(iso).getTime();
	if (!Number.isFinite(ms)) return iso;
	const diff = Date.now() - ms;
	if (diff < 60_000) return "just now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	return new Date(ms).toLocaleString();
}

function statusBadge(s: string): { label: string; className: string } {
	const lower = s.toLowerCase();
	if (lower.includes("running") || lower.includes("active")) return { label: s, className: "badge info" };
	if (lower.includes("error") || lower.includes("fail")) return { label: s, className: "badge err" };
	if (lower.includes("blocked") || lower.includes("login")) return { label: s, className: "badge warn" };
	if (lower.includes("complete") || lower.includes("done")) return { label: s, className: "badge muted" };
	if (lower.includes("stopped") || lower.includes("terminal")) return { label: s, className: "badge muted" };
	return { label: s, className: "badge muted" };
}

export function SubagentsPane() {
	const fetcher = useCallback(async () => {
		const res = await rpc.request.tasksList({});
		return res.tasks;
	}, []);
	const { data, error, refresh } = usePoller<TaskRow[]>(fetcher, 4000);
	const [selected, setSelected] = useState<string | null>(null);
	const [tail, setTail] = useState<string>("");
	const [input, setInput] = useState("");
	const [busy, setBusy] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const tailRef = useRef<HTMLPreElement>(null);

	const loadTail = useCallback(async (sessionId: string) => {
		try {
			const res = await rpc.request.tasksTail({ sessionId, lines: 200 });
			setTail(res.output);
			setTimeout(() => {
				if (tailRef.current) tailRef.current.scrollTop = tailRef.current.scrollHeight;
			}, 30);
		} catch (err) {
			setTail(`(error tailing: ${err instanceof Error ? err.message : String(err)})`);
		}
	}, []);

	useEffect(() => {
		if (!selected) return;
		void loadTail(selected);
		const t = setInterval(() => void loadTail(selected), 3000);
		return () => clearInterval(t);
	}, [selected, loadTail]);

	const send = useCallback(async () => {
		if (!selected || !input.trim()) return;
		setBusy(true);
		setActionError(null);
		try {
			const res = await rpc.request.tasksSend({ sessionId: selected, input });
			if (!res.ok) setActionError(res.error ?? "Send failed.");
			else setInput("");
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
			void loadTail(selected);
		}
	}, [selected, input, loadTail]);

	const finalize = useCallback(async (row: TaskRow) => {
		const prompt = `Please call FINALIZE_WORKSPACE for the workspace at ${row.workdir} (session ${row.sessionId}). Use a sensible commitMessage based on what you did. Open a draft PR back to the base branch. After it lands, summarize the diff back to me.`;
		try {
			await rpc.request.chatSend({ convId: "default", text: prompt });
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err));
		}
	}, []);

	const stop = useCallback(async (sessionId: string) => {
		if (!confirm(`Stop subagent ${sessionId.slice(0, 8)}…? In-flight work will be lost.`)) return;
		setBusy(true);
		setActionError(null);
		try {
			const res = await rpc.request.tasksStop({ sessionId });
			if (!res.ok) setActionError(res.error ?? "Stop failed.");
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
			refresh();
			if (selected === sessionId) {
				setSelected(null);
				setTail("");
			}
		}
	}, [refresh, selected]);

	if (error) return <div className="banner error">{error}</div>;
	if (!data) return <div className="empty">Loading subagents…</div>;

	return (
		<div className="pensieve-tasks">
			{actionError && <div className="banner error" style={{ margin: "10px 18px 0" }}>{actionError}</div>}

			<div className="pensieve-toolbar">
				<span className="badge muted">{data.length} subagent{data.length === 1 ? "" : "s"}</span>
				<span className="hint" style={{ marginLeft: "auto" }}>polling 4s</span>
			</div>

			<div className="pensieve-tasks-body" style={{ display: "grid", gridTemplateColumns: "minmax(360px, 1fr) 2fr", gap: 12 }}>
				<section className="pensieve-tasks-section">
					<h3 className="pensieve-tasks-section-title">Running coding subagents</h3>
					<p className="hint" style={{ margin: "0 0 8px" }}>
						Spawned via CREATE_TASK. Click one to tail its PTY output and send follow-up input.
					</p>
					{data.length === 0 ? (
						<div className="empty">
							No subagents running. The agent will spawn one when you ask for an open-ended build
							("make me a web app for X", "refactor the auth flow") and CREATE_TASK fires.
						</div>
					) : (
						<div className="pensieve-task-list">
							{data.map((t) => {
								const sb = statusBadge(t.status);
								const isSel = selected === t.sessionId;
								return (
									<div
										key={t.sessionId}
										className={`pensieve-task-row${isSel ? " active" : ""}`}
										onClick={() => setSelected(t.sessionId)}
										style={{ cursor: "pointer" }}
									>
										<div className="pensieve-task-row-header">
											<span className="pensieve-task-name">{t.label}</span>
											<span className={sb.className}>{sb.label}</span>
											<span className="badge muted">{t.agentType}</span>
											<span style={{ flex: 1 }} />
											{(t.status.toLowerCase().includes("complete") || t.status.toLowerCase().includes("done")) && (
												<button
													type="button"
													className="link"
													disabled={busy}
													onClick={(e) => { e.stopPropagation(); void finalize(t); }}
													title="Tell the agent to commit + open a PR for this workspace"
												>
													finalize → PR
												</button>
											)}
											<button
												type="button"
												className="link danger"
												disabled={busy}
												onClick={(e) => { e.stopPropagation(); void stop(t.sessionId); }}
											>
												stop
											</button>
										</div>
										<div className="pensieve-task-meta">
											<span className="hint" title={t.workdir}>workdir: {t.workdir}</span>
										</div>
										<div className="pensieve-task-meta">
											<span className="hint">last: {fmtRelative(t.lastActivityAt)}</span>
											<span className="hint">started: {fmtRelative(t.createdAt)}</span>
										</div>
										<div className="pensieve-trajectory-id">{t.sessionId}</div>
									</div>
								);
							})}
						</div>
					)}
				</section>

				<section className="pensieve-tasks-section">
					<h3 className="pensieve-tasks-section-title">
						{selected ? `Output — ${selected.slice(0, 12)}…` : "Output"}
					</h3>
					{!selected ? (
						<div className="empty">Select a subagent to tail its PTY output.</div>
					) : (
						<>
							<pre
								ref={tailRef}
								style={{
									background: "var(--surface-2, #111)",
									color: "var(--text, #ddd)",
									padding: 10,
									minHeight: 200,
									maxHeight: 360,
									overflow: "auto",
									fontSize: 11,
									lineHeight: 1.4,
									borderRadius: 4,
									whiteSpace: "pre-wrap",
									wordBreak: "break-word",
								}}
							>
								{tail || "(no output yet)"}
							</pre>
							<div style={{ display: "flex", gap: 8, marginTop: 8 }}>
								<input
									type="text"
									value={input}
									onChange={(e) => setInput(e.target.value)}
									onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
									placeholder="Send input to the subagent…"
									disabled={busy}
									style={{ flex: 1, padding: 6 }}
								/>
								<button type="button" className="btn primary small" onClick={() => void send()} disabled={busy || !input.trim()}>
									send
								</button>
							</div>
						</>
					)}
				</section>
			</div>
		</div>
	);
}
