/**
 * Per-channel feed inside the chat hub. Renders the gateway feed
 * filtered to a single channel — message-by-message, both sides of
 * the conversation. Read-only for now (no per-channel composer); the
 * agent chat tab is the canonical place to talk to the agent.
 *
 * Polls every 4s — feed turnover is low (a few new entries per
 * conversation), and the gateway is in-process so the call is cheap.
 */

import { useCallback, useEffect, useState } from "react";
import type { ChannelStatus } from "../../shared/index";
import { GitHubChannelFeed } from "./GitHubChannelFeed";

type GatewayMessage = {
	id: string;
	time: number;
	direction: "in" | "out" | "deleted" | "interaction";
	channel: string;
	source: string;
	roomId: string;
	entityId: string;
	externalHandle?: string;
	text: string;
	meta?: { trajectoryId?: string; trajectoryStepId?: string; action?: string };
};
import { rpc } from "../rpc";

const DIRECTION_LABEL: Record<string, string> = {
	in: "→",
	out: "←",
	deleted: "✗",
	interaction: "•",
};

function fmtTime(ts: number): string {
	const d = new Date(ts);
	const diff = Date.now() - ts;
	if (diff < 60_000) return "just now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
	return d.toLocaleString();
}

export function ChannelView({ channel }: { channel: ChannelStatus }) {
	// GitHub is event-shaped, not chat-shaped — render the dedicated
	// agent/user split instead of the gateway feed (which is empty here).
	if (channel.id === "github") return <GitHubChannelFeed channel={channel} />;
	return <GatewayFeedView channel={channel} />;
}

function GatewayFeedView({ channel }: { channel: ChannelStatus }) {
	const [messages, setMessages] = useState<GatewayMessage[]>([]);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const res = await rpc.request.gatewayFeed({ channel: channel.id, limit: 200 } as never);
			setMessages(res.messages as unknown as GatewayMessage[]);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [channel.id]);

	useEffect(() => {
		void load();
		const t = setInterval(load, 4000);
		return () => clearInterval(t);
	}, [load]);

	const sorted = [...messages].sort((a, b) => b.time - a.time);

	return (
		<div className="hub-channel">
			<header className="hub-channel-header">
				<div>
					<h2>{channel.label}</h2>
					<div className="hint">
						{channel.liveStatus === "online"
							? "Connected · live feed below"
							: channel.liveStatus === "off" && !channel.configured
								? "Not configured. Wire credentials in Messaging connections."
								: `Status: ${channel.liveStatus}`}
					</div>
				</div>
				<button
					type="button"
					className="btn ghost small"
					onClick={() => void load()}
				>
					Refresh
				</button>
			</header>
			{error && <div className="banner error" style={{ margin: "0 16px" }}>{error}</div>}
			{sorted.length === 0 ? (
				<div className="empty">
					No messages yet. Activity from this channel will land here as
					the agent receives or sends them.
				</div>
			) : (
				<ul className="hub-channel-list">
					{sorted.map((m) => (
						<li key={m.id} className={`hub-channel-row dir-${m.direction}`}>
							<span className="hub-channel-dir">
								{DIRECTION_LABEL[m.direction] ?? "?"}
							</span>
							<div className="hub-channel-body">
								<div className="hub-channel-meta">
									{m.externalHandle && (
										<span className="hub-channel-handle">@{m.externalHandle}</span>
									)}
									<span className="hub-channel-time">{fmtTime(m.time)}</span>
								</div>
								<div className="hub-channel-text">{m.text}</div>
								{m.direction === "out" && m.meta?.trajectoryId && (
									<ChannelFeedback
										traceId={m.meta.trajectoryId}
										convId={`channel:${channel.id}`}
										text={m.text}
									/>
								)}
							</div>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function ChannelFeedback({
	traceId,
	convId,
	text,
}: {
	traceId: string;
	convId: string;
	text: string;
}) {
	const [rating, setRating] = useState<1 | -1 | null>(null);
	const [busy, setBusy] = useState(false);
	const send = async (r: 1 | -1) => {
		if (busy) return;
		const next = rating === r ? null : r;
		setBusy(true);
		try {
			// Record the rating; toggling to null still sends (so the server
			// can write a "rating cleared" memory if it cares to). The
			// existing handler tolerates either rating value.
			if (next !== null) {
				await rpc.request.chatRateMessage({
					traceId,
					convId,
					rating: next,
					text: text.slice(0, 500),
				});
			}
			setRating(next);
		} catch {
			/* swallow — rating is best-effort */
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="hub-channel-feedback">
			<button
				type="button"
				className={`bubble-feedback-btn up ${rating === 1 ? "active" : ""}`}
				onClick={() => void send(1)}
				disabled={busy}
				aria-label="Thumbs up"
				title="Helpful"
			>
				👍
			</button>
			<button
				type="button"
				className={`bubble-feedback-btn down ${rating === -1 ? "active" : ""}`}
				onClick={() => void send(-1)}
				disabled={busy}
				aria-label="Thumbs down"
				title="Not helpful"
			>
				👎
			</button>
		</div>
	);
}
