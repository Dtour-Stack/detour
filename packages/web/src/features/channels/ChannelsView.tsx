/**
 * Top-level Channels window.
 *
 * Stacked expandable cards — one per channel (Discord / Telegram / iMessage).
 * Header shows status + toggle/expand control; expanded body shows credential
 * form, channel description, and a live message-history feed pulled from the
 * agent's *trajectories* table filtered by source (discord/telegram/imessage).
 *
 * The trajectories table already records every conversation turn (input,
 * LLM calls, actions) so we don't build a parallel store — the channel's
 * "message history" is just /api/activity/trajectories?source=<channel>.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
	ActivityTrajectoryListItem,
	ActivityTrajectoryListResult,
	ChannelStatus,
	ChannelsSnapshot,
} from "@detour/shared";
import { WebClient } from "../../api/client";

const CHANNEL_ICONS: Record<string, string> = {
	discord: "💬",
	telegram: "✈️",
	imessage: "💙",
};

export function ChannelsView() {
	const client = useMemo(() => new WebClient(), []);
	const [connected, setConnected] = useState(false);
	const [snap, setSnap] = useState<ChannelsSnapshot | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [expandedId, setExpandedId] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const s = await client.channelsList();
			setSnap(s);
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [client]);

	useEffect(() => {
		client.connect().then(() => setConnected(true)).catch(() => setConnected(true));
		void load();
		const t = setInterval(load, 8000);
		return () => clearInterval(t);
	}, [client, load]);

	return (
		<div className="settings-shell">
			<aside className="settings-sidebar">
				<div className="window-brand">Channels</div>
				<div className="hint" style={{ padding: "0 12px 12px", lineHeight: 1.5 }}>
					Wire messaging connectors. Per-channel history comes from the agent's trajectory log.
				</div>
				<div className="sidebar-section">
					<div className="section-btn active" aria-hidden>Configured</div>
					<div className="sub-nav">
						{(snap?.channels ?? []).map((c) => (
							<button
								key={c.id}
								type="button"
								className={`sub-nav-btn ${expandedId === c.id ? "active" : ""}`}
								onClick={() => setExpandedId((cur) => cur === c.id ? null : c.id)}
							>
								<span style={{ flex: 1 }}>{c.label}</span>
								<span className={`badge ${statusTone(c)}`} style={{ fontSize: 9 }}>
									{statusLabel(c)}
								</span>
							</button>
						))}
					</div>
				</div>
				<div style={{ flex: 1 }} />
				<div className="window-status">{connected ? "● connected" : "○ connecting…"}</div>
			</aside>
			<main className="settings-main settings-main-flush">
				<div className="channels-stack">
					{error && <div className="banner error">{error}</div>}
					{snap?.channels.map((c) => (
						<ChannelCard
							key={c.id}
							client={client}
							channel={c}
							expanded={expandedId === c.id}
							onToggleExpand={() => setExpandedId((cur) => cur === c.id ? null : c.id)}
							onChanged={load}
						/>
					))}
					{!snap && !error && <div className="empty">Loading…</div>}
				</div>
			</main>
		</div>
	);
}

function statusTone(c: ChannelStatus): string {
	switch (c.liveStatus) {
		case "online":         return "ok";
		case "connecting":     return "info";
		case "loaded":         return "info";
		case "invalid-token":  return "err";
		case "error":          return "err";
		case "off":
		default:               return "muted";
	}
}
function statusLabel(c: ChannelStatus): string {
	if (!c.platformAvailable) return "n/a";
	switch (c.liveStatus) {
		case "online":         return "online";
		case "connecting":     return "connecting…";
		case "loaded":         return "loaded";
		case "invalid-token":  return "bad token";
		case "error":          return "error";
		case "off":
		default:               return c.configured ? "configured" : "off";
	}
}

function ChannelCard({
	client,
	channel,
	expanded,
	onToggleExpand,
	onChanged,
}: {
	client: WebClient;
	channel: ChannelStatus;
	expanded: boolean;
	onToggleExpand: () => void;
	onChanged: () => Promise<void> | void;
}) {
	const [draft, setDraft] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [reloading, setReloading] = useState(false);

	const setKey = useCallback(async (key: string) => {
		const value = draft[key];
		if (!value) return;
		setBusy(key);
		setActionError(null);
		try {
			await client.channelSetCredential(key, value);
			setDraft((d) => ({ ...d, [key]: "" }));
			await onChanged();
		} catch (e) {
			setActionError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(null);
		}
	}, [client, draft, onChanged]);

	const clearKey = useCallback(async (key: string) => {
		if (!confirm(`Clear credential ${key}?`)) return;
		setBusy(key);
		setActionError(null);
		try {
			await client.channelClearCredential(key);
			await onChanged();
		} catch (e) {
			setActionError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(null);
		}
	}, [client, onChanged]);

	const reload = useCallback(async () => {
		setReloading(true);
		setActionError(null);
		try {
			await client.channelsReload();
			// Reload runs in the background (telegram retries can take
			// minutes); poll for ~6s so the UI shows the new state.
			let i = 0;
			const tick = () => {
				i += 1;
				void onChanged();
				if (i < 6) setTimeout(tick, 1000);
				else setReloading(false);
			};
			setTimeout(tick, 1000);
		} catch (e) {
			setActionError(e instanceof Error ? e.message : String(e));
			setReloading(false);
		}
	}, [client, onChanged]);

	const toggleEnabled = useCallback(async () => {
		setBusy("toggle");
		setActionError(null);
		try {
			if (channel.id === "imessage") {
				if (channel.configured) {
					if (!confirm("Disable iMessage bridge?")) { setBusy(null); return; }
					await client.channelClearCredential("IMESSAGE_ENABLED");
				} else {
					await client.channelSetCredential("IMESSAGE_ENABLED", "true");
				}
				await onChanged();
				if (!expanded) onToggleExpand();
			} else if (channel.configured) {
				if (!confirm(`Disable ${channel.label}? This will clear stored credentials.`)) { setBusy(null); return; }
				for (const k of channel.requiredVaultKeys) await client.channelClearCredential(k);
				await onChanged();
			} else {
				if (!expanded) onToggleExpand();
			}
		} catch (e) {
			setActionError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(null);
		}
	}, [channel, client, onChanged]);

	const allKeys = [...channel.requiredVaultKeys, ...channel.optionalVaultKeys];
	const isEnabled = channel.configured;

	return (
		<div className={`channel-card ${expanded ? "expanded" : ""} ${isEnabled ? "enabled" : ""}`}>
			<div className="channel-card-header">
				<button
					type="button"
					className="channel-card-expand"
					onClick={onToggleExpand}
					aria-expanded={expanded}
				>
					<span className="channel-card-icon" aria-hidden>{CHANNEL_ICONS[channel.id] ?? "🔌"}</span>
					<div className="channel-card-title">
						<div className="channel-card-name">{channel.label}</div>
						<div className="channel-card-sub">{channel.description}</div>
					</div>
					<div className="channel-card-status">
						<span className={`badge ${statusTone(channel)}`} title={channel.liveDetail ?? ""}>
							{statusLabel(channel)}
						</span>
						{!channel.pluginLoaded && channel.configured && (
							<span className="badge warn" title="Plugin not loaded yet — reload runtime">reload needed</span>
						)}
						{!channel.platformAvailable && (
							<span className="badge muted">{channel.platform}-only</span>
						)}
					</div>
					<span className="channel-card-twirl" aria-hidden>{expanded ? "▾" : "▸"}</span>
				</button>
				<button
					type="button"
					className={`channel-toggle ${isEnabled ? "on" : "off"}`}
					disabled={busy === "toggle" || !channel.platformAvailable}
					onClick={toggleEnabled}
					title={isEnabled ? `Disable ${channel.label}` : `Enable ${channel.label}`}
					aria-label={isEnabled ? `Disable ${channel.label}` : `Enable ${channel.label}`}
				>
					<span className="channel-toggle-knob" />
				</button>
			</div>

			{expanded && (
				<div className="channel-card-body">
					{actionError && <div className="banner error" style={{ marginBottom: 8 }}>{actionError}</div>}
					{!channel.platformAvailable && (
						<div className="banner warn" style={{ marginBottom: 8 }}>
							This channel requires {channel.platform}.
						</div>
					)}
					{channel.liveDetail && (channel.liveStatus === "invalid-token" || channel.liveStatus === "error" || channel.liveStatus === "connecting") && (
						<div className={`banner ${channel.liveStatus === "invalid-token" || channel.liveStatus === "error" ? "error" : "warn"}`} style={{ marginBottom: 8 }}>
							{channel.liveDetail}
						</div>
					)}
					{channel.liveStatus === "online" && channel.liveDetail && (
						<div className="banner ok" style={{ marginBottom: 8, fontSize: 12 }}>
							✓ {channel.liveDetail}
						</div>
					)}

					{channel.id === "imessage" && channel.pluginLoaded && (
						<ImessageTccBanner client={client} />
					)}

					{channel.id === "discord" && channel.liveStatus === "online" && (
						<DiscordBackfillSection client={client} />
					)}

					{allKeys.length > 0 && (
						<section className="channel-card-section">
							<h4 className="channel-card-section-title">Credentials</h4>
							<div className="channel-creds">
								{allKeys.map((key) => {
									const required = channel.requiredVaultKeys.includes(key);
									const missing = channel.missingKeys.includes(key);
									return (
										<div key={key} className="channel-cred-row">
											<label className="channel-cred-label">
												<span className="form-label">{key}</span>
												<span className="hint">{required ? "required" : "optional"} · {missing ? "not set" : "stored"}</span>
											</label>
											<div className="row" style={{ gap: 6 }}>
												<input
													type="password"
													value={draft[key] ?? ""}
													onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
													placeholder={missing ? "paste value…" : "(stored — paste to overwrite)"}
													className="pensieve-input"
													style={{ flex: 1 }}
												/>
												<button type="button" className="btn small" disabled={busy === key || !draft[key]} onClick={() => setKey(key)}>
													{busy === key ? "Saving…" : "Save"}
												</button>
												{!missing && (
													<button type="button" className="btn small ghost" disabled={busy === key} onClick={() => clearKey(key)}>
														Clear
													</button>
												)}
											</div>
										</div>
									);
								})}
							</div>
						</section>
					)}

					<section className="channel-card-section">
						<div className="channel-card-section-row">
							<h4 className="channel-card-section-title">Status</h4>
							{channel.configured && !channel.pluginLoaded && (
								<button type="button" className="btn small" disabled={reloading} onClick={reload}>
									{reloading ? "Reloading…" : "Load plugin (rebuild runtime)"}
								</button>
							)}
						</div>
						<dl className="channel-status">
							<dt>Plugin</dt><dd className="mono">{channel.pluginPackage}</dd>
							<dt>Platform</dt><dd>{channel.platform === "any" ? "any" : `${channel.platform} (${channel.platformAvailable ? "ok" : "unavailable"})`}</dd>
							<dt>Configured</dt><dd>{channel.configured ? "yes" : "no"}</dd>
							<dt>Loaded into runtime</dt><dd>{channel.pluginLoaded ? "yes" : "no"}</dd>
						</dl>
					</section>

					<section className="channel-card-section">
						<h4 className="channel-card-section-title">Recent activity (from trajectories)</h4>
						<ChannelHistory client={client} sourceId={channel.id} pluginLoaded={channel.pluginLoaded} />
					</section>
				</div>
			)}
		</div>
	);
}

function ChannelHistory({
	client,
	sourceId,
	pluginLoaded,
}: {
	client: WebClient;
	sourceId: string;
	pluginLoaded: boolean;
}) {
	const [data, setData] = useState<ActivityTrajectoryListResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const r = await client.activityTrajectories({ source: sourceId, limit: 20 });
			setData(r);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, [client, sourceId]);

	useEffect(() => {
		void load();
		const t = setInterval(load, 8000);
		return () => clearInterval(t);
	}, [load]);

	if (error) return <div className="banner error">{error}</div>;
	if (loading && !data) return <div className="hint">Loading history…</div>;
	if (!data || data.trajectories.length === 0) {
		return (
			<div className="empty">
				No trajectories from this channel yet.
				{!pluginLoaded && " Load the plugin first, then send a message."}
			</div>
		);
	}
	return (
		<div className="channel-history">
			<div className="hint" style={{ marginBottom: 6 }}>
				Showing {data.trajectories.length} of {data.total} · live
			</div>
			{data.trajectories.map((t) => <ChannelHistoryRow key={t.id} item={t} />)}
		</div>
	);
}

function DiscordBackfillSection({ client }: { client: WebClient }) {
	const [guilds, setGuilds] = useState<Array<{ id: string; name: string; channels: Array<{ id: string; name: string; type: number }> }> | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [results, setResults] = useState<Record<string, string>>({});
	const [limit, setLimit] = useState(200);

	const load = useCallback(async () => {
		try {
			const r = await client.discordGuilds();
			setGuilds(r.guilds);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [client]);

	useEffect(() => { void load(); }, [load]);

	const backfill = async (channelId: string) => {
		setBusy(channelId);
		setResults((r) => ({ ...r, [channelId]: "scheduling…" }));
		try {
			await client.discordBackfill(channelId, limit, false);
			setResults((r) => ({ ...r, [channelId]: `backfilling ${limit} msgs (running in background — check Activity > Trajectories for source=discord)` }));
		} catch (e) {
			setResults((r) => ({ ...r, [channelId]: `error: ${e instanceof Error ? e.message : String(e)}` }));
		} finally {
			setBusy(null);
		}
	};

	if (error) return <div className="banner error">{error}</div>;
	if (!guilds) return <div className="hint">Loading channels…</div>;
	if (guilds.length === 0) return <div className="empty" style={{ marginTop: 8 }}>Bot is in 0 servers — invite it first.</div>;

	// Discord channel types: 0 = GUILD_TEXT, 5 = GUILD_ANNOUNCEMENT
	const TEXT_TYPES = new Set([0, 5]);

	return (
		<section className="channel-card-section">
			<div className="channel-card-section-row">
				<h4 className="channel-card-section-title">History backfill</h4>
				<label className="hint" style={{ display: "flex", gap: 6, alignItems: "center" }}>
					last
					<input
						type="number"
						min={10}
						max={2000}
						step={50}
						value={limit}
						onChange={(e) => setLimit(Math.max(10, Math.min(2000, Number(e.target.value) || 200)))}
						className="pensieve-input"
						style={{ width: 70, fontSize: 11, padding: "3px 6px" }}
					/>
					messages per channel
				</label>
			</div>
			<p className="hint" style={{ margin: "0 0 8px", lineHeight: 1.5 }}>
				Pull recent messages → memories → eliza extractors auto-build relationships + facts.
				Each call runs in the background; watch <strong>Activity → Trajectories</strong> filtered by <code>source=discord</code> for results.
			</p>
			{guilds.map((g) => {
				const textChannels = g.channels.filter((c) => TEXT_TYPES.has(c.type));
				return (
					<div key={g.id} className="discord-guild">
						<div className="discord-guild-name">{g.name} <span className="hint">· {textChannels.length} text channels</span></div>
						<div className="discord-channel-list">
							{textChannels.length === 0 ? (
								<div className="hint" style={{ fontSize: 11 }}>No text channels visible to bot.</div>
							) : textChannels.map((c) => (
								<div key={c.id} className="discord-channel-row">
									<span className="discord-channel-name">#{c.name}</span>
									<span className="hint discord-channel-result">{results[c.id] ?? ""}</span>
									<button
										type="button"
										className="btn small ghost"
										disabled={busy === c.id}
										onClick={() => backfill(c.id)}
									>
										{busy === c.id ? "…" : "Backfill"}
									</button>
								</div>
							))}
						</div>
					</div>
				);
			})}
		</section>
	);
}

function ImessageTccBanner({ client }: { client: WebClient }) {
	const [granted, setGranted] = useState<boolean | null>(null);
	const [opening, setOpening] = useState(false);

	useEffect(() => {
		client.listOsPermissions()
			.then((perms) => {
				const fda = perms.find((p) => p.id === "full-disk-access");
				setGranted(fda?.status === "granted");
			})
			.catch(() => setGranted(null));
	}, [client]);

	if (granted === true) {
		return (
			<div className="banner ok" style={{ marginBottom: 8, fontSize: 12 }}>
				✓ Full Disk Access granted — Detour can read your iMessages.
			</div>
		);
	}
	const open = async () => {
		setOpening(true);
		try { await client.openOsPermissionPane("full-disk-access"); }
		finally { setOpening(false); }
	};
	return (
		<div className="banner warn" style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
			<span style={{ flex: 1 }}>
				iMessage needs <strong>Full Disk Access</strong> to read <code>~/Library/Messages/chat.db</code>. Plugin is in send-only mode until granted.
			</span>
			<button type="button" className="btn small" disabled={opening} onClick={open}>
				{opening ? "Opening…" : "Open System Settings"}
			</button>
		</div>
	);
}

function ChannelHistoryRow({ item }: { item: ActivityTrajectoryListItem }) {
	return (
		<div className="channel-history-row">
			<div className="channel-history-header">
				<span className={`badge ${item.status === "completed" ? "ok" : item.status === "error" ? "err" : "muted"}`}>
					{item.status ?? "?"}
				</span>
				<span className="hint">{item.startTime ? new Date(item.startTime).toLocaleString() : ""}</span>
				<span style={{ flex: 1 }} />
				<span className="hint">{item.llmCallCount ?? 0} calls · {(item.totalPromptTokens ?? 0) + (item.totalCompletionTokens ?? 0)}t</span>
			</div>
			<div className="channel-history-id">{item.id}</div>
		</div>
	);
}
