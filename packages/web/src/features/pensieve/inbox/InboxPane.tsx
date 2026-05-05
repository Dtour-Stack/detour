/**
 * Pensieve > Inbox pane.
 *
 * Lists incoming notifications + auto-promoted channel signals, lets the user
 * post test notifications (which the agent can act on via its real reply
 * pipeline), and shows the agent's reply when a prompted item completes.
 *
 * Polls every 3 seconds — cheap, in-process API. No WebSocket needed since
 * inbox volume is low (notifications, mentions, identity conflicts).
 */

import { useCallback, useEffect, useState } from "react";
import type { InboxItem, WebClient } from "../../../api/client";

const STATUS_LABELS: Record<string, string> = {
	pending: "Pending",
	acknowledged: "Acknowledged",
	acted: "Agent replied",
	dismissed: "Dismissed",
};

function formatTime(ts: number): string {
	const d = new Date(ts);
	const now = Date.now();
	const diffMs = now - ts;
	if (diffMs < 60_000) return "just now";
	if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
	if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
	return d.toLocaleString();
}

export function InboxPane({ client }: { client: WebClient }) {
	const [items, setItems] = useState<InboxItem[]>([]);
	const [total, setTotal] = useState(0);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [composing, setComposing] = useState(false);
	const [draftTitle, setDraftTitle] = useState("");
	const [draftBody, setDraftBody] = useState("");
	const [postBusy, setPostBusy] = useState(false);

	const load = useCallback(async () => {
		try {
			const res = await client.listInbox({ limit: 100 });
			setItems(res.items);
			setTotal(res.total);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [client]);

	useEffect(() => {
		void load();
		const id = setInterval(() => void load(), 3_000);
		return () => clearInterval(id);
	}, [load]);

	const post = useCallback(async () => {
		if (!draftTitle.trim()) return;
		setPostBusy(true);
		try {
			await client.postInboxNotification({
				title: draftTitle.trim(),
				body: draftBody.trim(),
				prompt: true,
			});
			setDraftTitle("");
			setDraftBody("");
			setComposing(false);
			void load();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setPostBusy(false);
		}
	}, [client, draftTitle, draftBody, load]);

	const updateStatus = useCallback(async (id: string, status: string) => {
		try {
			await client.updateInboxStatus(id, status);
			void load();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [client, load]);

	return (
		<div className="settings-pane">
			<header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
				<div>
					<h2 style={{ margin: 0 }}>Inbox</h2>
					<div style={{ fontSize: 12, opacity: 0.7 }}>
						{loading ? "Loading…" : `${total} item${total === 1 ? "" : "s"}`}
						{" · auto-promoted channel messages and programmatic notifications"}
					</div>
				</div>
				<button
					type="button"
					onClick={() => setComposing((v) => !v)}
					style={{ padding: "6px 12px" }}
				>
					{composing ? "Cancel" : "+ New notification"}
				</button>
			</header>

			{composing && (
				<div style={{ border: "1px solid var(--border, #333)", padding: 12, borderRadius: 6, marginBottom: 16 }}>
					<input
						placeholder="Title"
						value={draftTitle}
						onChange={(e) => setDraftTitle(e.target.value)}
						style={{ width: "100%", marginBottom: 8, padding: 6 }}
					/>
					<textarea
						placeholder="Body (this becomes a real prompt to the agent)"
						value={draftBody}
						onChange={(e) => setDraftBody(e.target.value)}
						rows={3}
						style={{ width: "100%", marginBottom: 8, padding: 6, fontFamily: "inherit" }}
					/>
					<button type="button" onClick={() => void post()} disabled={postBusy || !draftTitle.trim()}>
						{postBusy ? "Posting…" : "Post (and prompt agent)"}
					</button>
					<div style={{ fontSize: 11, opacity: 0.6, marginTop: 6 }}>
						Posting fires <code>messageService.handleMessage</code> — the agent will run its
						full reply pipeline (planner → action → REPLY) in the background. The reply text
						appears below the item once complete.
					</div>
				</div>
			)}

			{error && <div style={{ color: "tomato", marginBottom: 12 }}>{error}</div>}

			{items.length === 0 ? (
				<div style={{ opacity: 0.6, padding: 20, textAlign: "center" }}>
					No inbox items yet. Channel messages from Discord/Telegram/iMessage auto-promote here,
					or click "+ New notification" to push one programmatically.
				</div>
			) : (
				<ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
					{items.map((item) => (
						<li
							key={item.id}
							style={{
								border: "1px solid var(--border, #333)",
								borderRadius: 6,
								padding: 12,
								marginBottom: 8,
								background: item.status === "pending" ? "rgba(100,100,255,0.05)" : "transparent",
							}}
						>
							<div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
								<strong>{item.title}</strong>
								<small style={{ opacity: 0.6 }}>{formatTime(item.time)}</small>
							</div>
							<div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>
								{item.kind} · {item.channel ?? "—"} · {item.source}
								{" · "}
								<span style={{ color: item.status === "acted" ? "lightgreen" : "inherit" }}>
									{STATUS_LABELS[item.status] ?? item.status}
								</span>
								{item.fromHandle ? ` · from ${item.fromHandle}` : ""}
							</div>
							{item.body && <div style={{ fontSize: 13, marginBottom: 6, whiteSpace: "pre-wrap" }}>{item.body}</div>}
							{item.replyText && (
								<div style={{ fontSize: 13, padding: 8, background: "rgba(100,255,100,0.08)", borderRadius: 4, marginTop: 6 }}>
									<strong style={{ fontSize: 11, opacity: 0.7 }}>Agent reply:</strong>
									<div style={{ marginTop: 2, whiteSpace: "pre-wrap" }}>{item.replyText}</div>
								</div>
							)}
							<div style={{ marginTop: 8, display: "flex", gap: 6 }}>
								{item.status === "pending" && (
									<>
										<button type="button" onClick={() => void updateStatus(item.id, "acknowledged")}>Acknowledge</button>
										<button type="button" onClick={() => void updateStatus(item.id, "dismissed")}>Dismiss</button>
									</>
								)}
								{item.status !== "pending" && item.status !== "dismissed" && (
									<button type="button" onClick={() => void updateStatus(item.id, "dismissed")}>Dismiss</button>
								)}
							</div>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
