/**
 * Detour hub > message feed.
 *
 * Live unified feed: every inbound + outbound message captured across
 * Discord, Telegram, iMessage, and the in-app chat.
 * Also surfaces cross-source identity merge candidates (when the same
 * external handle has been linked to multiple Detour entities).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
	GatewayMessage,
	IdentityCandidate as GatewayIdentityCandidate,
} from "../../../shared/rpc/gateway";
import { UI_POLL_INTERVAL_MS } from "../../../shared/timing";
import { rpc } from "../../rpc";

const CHANNEL_COLORS: Record<string, string> = {
	discord: "#5865F2",
	telegram: "#229ED9",
	imessage: "#34C759",
	chat: "#888",
	unknown: "#666",
};

const DIRECTION_LABEL: Record<string, string> = {
	in: "→",
	out: "←",
	deleted: "✗",
	interaction: "•",
};

function formatTime(ts: number): string {
	const d = new Date(ts);
	const now = Date.now();
	const diff = now - ts;
	if (diff < 60_000) return "just now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	return d.toLocaleString();
}

export function GatewayPane() {
	const [messages, setMessages] = useState<GatewayMessage[]>([]);
	const [identities, setIdentities] = useState<GatewayIdentityCandidate[]>([]);
	const [filter, setFilter] = useState<{ channel?: string; direction?: string; q?: string }>({});
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const [feed, ids] = await Promise.all([
				rpc.request.gatewayFeed({ ...filter, limit: 200 } as never),
				rpc.request.gatewayIdentities({}),
			]);
			setMessages(feed.messages as unknown as GatewayMessage[]);
			setIdentities(ids.identities as unknown as GatewayIdentityCandidate[]);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [filter]);

	useEffect(() => {
		void load();
		const id = setInterval(() => void load(), UI_POLL_INTERVAL_MS.gateway);
		return () => clearInterval(id);
	}, [load]);

	const sortedMessages = useMemo(
		() => [...messages].sort((a, b) => b.time - a.time),
		[messages],
	);

	return (
		<div className="settings-pane">
			<header style={{ marginBottom: 12 }}>
				<h2 style={{ margin: 0 }}>All messages</h2>
				<div style={{ fontSize: 12, opacity: 0.7 }}>
					Live unified inbound + outbound across messaging connectors. Recorded from
					elizaOS MESSAGE_RECEIVED / MESSAGE_SENT events.
				</div>
			</header>

			<div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
				<select
					value={filter.channel ?? ""}
					onChange={(e) => setFilter((f) => ({ ...f, channel: e.target.value || undefined }))}
				>
					<option value="">All sources</option>
					<option value="discord">Discord</option>
					<option value="telegram">Telegram</option>
					<option value="imessage">iMessage</option>
					<option value="chat">In-app chat</option>
					<option value="unknown">Unknown</option>
				</select>
				<select
					value={filter.direction ?? ""}
					onChange={(e) => setFilter((f) => ({ ...f, direction: e.target.value || undefined }))}
				>
					<option value="">All directions</option>
					<option value="in">Inbound (→)</option>
					<option value="out">Outbound (←)</option>
					<option value="deleted">Deleted</option>
					<option value="interaction">Interaction</option>
				</select>
				<input
					type="search"
					placeholder="Search text…"
					value={filter.q ?? ""}
					onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value || undefined }))}
					style={{ flex: 1, minWidth: 120 }}
				/>
			</div>

			{identities.length > 0 && (
				<div style={{ border: "1px solid #d97706", borderRadius: 6, padding: 10, marginBottom: 12, background: "rgba(217,119,6,0.06)" }}>
					<strong>Identity merge candidates ({identities.length})</strong>
					<div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>
						The same external handle has been mapped to multiple Detour entities.
						Inspect via Pensieve → Relationships and merge if they're the same person.
					</div>
					<ul style={{ listStyle: "none", padding: 0, margin: 0, fontSize: 12 }}>
						{identities.slice(0, 5).map((c) => (
							<li key={c.key}>
								<code>{c.channel}:{c.externalHandle}</code> → {c.entityIds.length} entities ({c.messageCount} msgs)
							</li>
						))}
					</ul>
				</div>
			)}

			{error && <div style={{ color: "tomato", marginBottom: 12 }}>{error}</div>}

			{sortedMessages.length === 0 ? (
				<div style={{ opacity: 0.6, padding: 20, textAlign: "center" }}>
					No messages captured yet. Send a chat or hook up Discord/Telegram with valid tokens.
				</div>
			) : (
				<ul style={{ listStyle: "none", padding: 0, margin: 0, fontSize: 13 }}>
					{sortedMessages.map((m) => {
						const color = CHANNEL_COLORS[m.channel] ?? CHANNEL_COLORS.unknown;
						return (
							<li
								key={m.id}
								style={{
									display: "grid",
									gridTemplateColumns: "auto 60px 1fr auto",
									gap: 10,
									alignItems: "baseline",
									padding: "6px 8px",
									borderBottom: "1px solid rgba(255,255,255,0.05)",
								}}
							>
								<span style={{ color, fontFamily: "monospace", fontSize: 11, fontWeight: 600 }}>
									{DIRECTION_LABEL[m.direction] ?? "?"} {m.channel}
								</span>
								<span style={{ opacity: 0.6, fontSize: 11 }}>{formatTime(m.time)}</span>
								<span style={{ whiteSpace: "pre-wrap", overflow: "hidden", textOverflow: "ellipsis" }}>
									{m.externalHandle ? (
										<small style={{ opacity: 0.7, marginRight: 6 }}>@{m.externalHandle}</small>
									) : null}
									{m.text}
								</span>
								<span style={{ opacity: 0.4, fontSize: 11 }}>{m.source}</span>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}
