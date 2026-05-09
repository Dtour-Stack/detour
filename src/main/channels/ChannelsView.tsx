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

import { useCallback, useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
	ActivityTrajectoryListItem,
	ActivityTrajectoryListResult,
	ChannelStatus,
	ChannelsSnapshot,
} from "../../shared/index";
import type { ChannelsDiscordCatchUpResult } from "../../shared/rpc/channels";
import type { GitHubActivityEvent, GitHubChannelRole, GitHubIdentity } from "../../shared/rpc/github-channel";
import { rpc } from "../rpc";
import { useDetourTheme } from "../useDetourTheme";
import { SidebarIcon } from "../SidebarIcon";

const CHANNEL_ICONS: Record<string, string> = {
	discord: "💬",
	telegram: "✈️",
	github: "GH",
	imessage: "💙",
};

export function ChannelsView() {
	useDetourTheme();
	const [snap, setSnap] = useState<ChannelsSnapshot | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [expandedId, setExpandedId] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const s = await rpc.request.channelsList({});
			setSnap(s);
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, []);

	useEffect(() => {
		void load();
		const t = setInterval(load, 8000);
		return () => clearInterval(t);
	}, [load]);

	return (
		<div className="settings-shell">
			<aside className="settings-sidebar">
				<div className="window-brand">Channels</div>
				<div className="hint section-btn-label" style={{ padding: "0 12px 12px", lineHeight: 1.5 }}>
					Wire messaging connectors. Per-channel history comes from the agent's trajectory log.
				</div>
				<div className="sidebar-section">
					<div className="section-btn active" aria-hidden title="Configured">
						<SidebarIcon name="chat" />
						<span className="section-btn-label">Configured</span>
					</div>
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
			</aside>
			<main className="settings-main settings-main-flush">
				<div className="channels-stack">
					{error && <div className="banner error">{error}</div>}
					{snap?.channels.map((c) => (
						<ChannelCard
							key={c.id}
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
	channel,
	expanded,
	onToggleExpand,
	onChanged,
}: {
	channel: ChannelStatus;
	expanded: boolean;
	onToggleExpand: () => void;
	onChanged: () => Promise<void> | void;
}) {
	const actions = useChannelCardActions({ channel, expanded, onChanged, onToggleExpand });

	const allKeys = [...channel.requiredVaultKeys, ...channel.optionalVaultKeys];
	const isEnabled = channel.configured;

	return (
		<div className={`channel-card ${expanded ? "expanded" : ""} ${isEnabled ? "enabled" : ""}`}>
			<ChannelCardHeader
				channel={channel}
				expanded={expanded}
				isEnabled={isEnabled}
				toggleBusy={actions.busy === "toggle"}
				onToggleExpand={onToggleExpand}
				onToggleEnabled={actions.toggleEnabled}
			/>
			{expanded && (
				<ChannelCardBody
					channel={channel}
					actionError={actions.actionError}
					allKeys={allKeys}
					busy={actions.busy}
					draft={actions.draft}
					reloading={actions.reloading}
					onClearKey={actions.clearKey}
					onDraftChange={actions.setDraft}
					onReload={actions.reload}
					onSetKey={actions.setKey}
					onSetSetting={actions.setSetting}
				/>
			)}
		</div>
	);
}

function useChannelCardActions({
	channel,
	expanded,
	onChanged,
	onToggleExpand,
}: {
	channel: ChannelStatus;
	expanded: boolean;
	onChanged: () => Promise<void> | void;
	onToggleExpand: () => void;
}) {
	const [draft, setDraft] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [reloading, setReloading] = useState(false);
	const setKey = useCallback((key: string) => {
		void saveChannelKey({ key, draft, onChanged, setActionError, setBusy, setDraft });
	}, [draft, onChanged]);
	const clearKey = useCallback((key: string) => {
		void clearChannelKey({ key, onChanged, setActionError, setBusy });
	}, [onChanged]);
	const reload = useCallback(() => {
		void reloadChannelPlugins({ onChanged, setActionError, setReloading });
	}, [onChanged]);
	const setSetting = useCallback((key: string, value: boolean) => {
		void saveChannelSetting({ key, value, onChanged, setActionError, setBusy, setReloading });
	}, [onChanged]);
	const toggleEnabled = useCallback(() => {
		void toggleChannelEnabled({ channel, expanded, onChanged, onToggleExpand, setActionError, setBusy });
	}, [channel, expanded, onChanged, onToggleExpand]);
	return { actionError, busy, clearKey, draft, reload, reloading, setDraft, setKey, setSetting, toggleEnabled };
}

async function saveChannelKey({
	key,
	draft,
	onChanged,
	setActionError,
	setBusy,
	setDraft,
}: {
	key: string;
	draft: Record<string, string>;
	onChanged: () => Promise<void> | void;
	setActionError: (value: string | null) => void;
	setBusy: (value: string | null) => void;
	setDraft: Dispatch<SetStateAction<Record<string, string>>>;
}) {
	const value = draft[key];
	if (!value) return;
	setBusy(key);
	setActionError(null);
	try {
		await rpc.request.channelsSetCredential({ key, value });
		setDraft((d) => ({ ...d, [key]: "" }));
		await onChanged();
	} catch (e) {
		setActionError(e instanceof Error ? e.message : String(e));
	} finally {
		setBusy(null);
	}
}

async function clearChannelKey({
	key,
	onChanged,
	setActionError,
	setBusy,
}: {
	key: string;
	onChanged: () => Promise<void> | void;
	setActionError: (value: string | null) => void;
	setBusy: (value: string | null) => void;
}) {
	if (!confirm(`Clear credential ${key}?`)) return;
	setBusy(key);
	setActionError(null);
	try {
		await rpc.request.channelsClearCredential({ key });
		await onChanged();
	} catch (e) {
		setActionError(e instanceof Error ? e.message : String(e));
	} finally {
		setBusy(null);
	}
}

async function reloadChannelPlugins({
	onChanged,
	setActionError,
	setReloading,
}: {
	onChanged: () => Promise<void> | void;
	setActionError: (value: string | null) => void;
	setReloading: (value: boolean) => void;
}) {
	setReloading(true);
	setActionError(null);
	try {
		await rpc.request.channelsReload({});
		pollChannelReload(onChanged, setReloading);
	} catch (e) {
		setActionError(e instanceof Error ? e.message : String(e));
		setReloading(false);
	}
}

async function saveChannelSetting({
	key,
	value,
	onChanged,
	setActionError,
	setBusy,
	setReloading,
}: {
	key: string;
	value: boolean;
	onChanged: () => Promise<void> | void;
	setActionError: (value: string | null) => void;
	setBusy: (value: string | null) => void;
	setReloading: (value: boolean) => void;
}) {
	setBusy(key);
	setActionError(null);
	try {
		await rpc.request.channelsSetCredential({ key, value: value ? "true" : "false" });
		await onChanged();
		setReloading(true);
		pollChannelReload(onChanged, setReloading);
	} catch (e) {
		setActionError(e instanceof Error ? e.message : String(e));
		setReloading(false);
	} finally {
		setBusy(null);
	}
}

function pollChannelReload(onChanged: () => Promise<void> | void, setReloading: (value: boolean) => void): void {
	let i = 0;
	const tick = () => {
		i += 1;
		void onChanged();
		if (i < 6) setTimeout(tick, 1000);
		else setReloading(false);
	};
	setTimeout(tick, 1000);
}

async function toggleChannelEnabled({
	channel,
	expanded,
	onChanged,
	onToggleExpand,
	setActionError,
	setBusy,
}: {
	channel: ChannelStatus;
	expanded: boolean;
	onChanged: () => Promise<void> | void;
	onToggleExpand: () => void;
	setActionError: (value: string | null) => void;
	setBusy: (value: string | null) => void;
}) {
	setBusy("toggle");
	setActionError(null);
	try {
		if (channel.id === "imessage") {
			await toggleImessageChannel(channel);
			await onChanged();
			if (!expanded) onToggleExpand();
		} else if (channel.configured) {
			if (!confirm(`Disable ${channel.label}? This will clear stored credentials.`)) return;
			await Promise.all([...channel.requiredVaultKeys, ...channel.optionalVaultKeys].map((key) => rpc.request.channelsClearCredential({ key })));
			await onChanged();
		} else if (!expanded) {
			onToggleExpand();
		}
	} catch (e) {
		setActionError(e instanceof Error ? e.message : String(e));
	} finally {
		setBusy(null);
	}
}

async function toggleImessageChannel(channel: ChannelStatus): Promise<void> {
	if (channel.configured) {
		if (!confirm("Disable iMessage bridge?")) return;
		await rpc.request.channelsClearCredential({ key: "IMESSAGE_ENABLED" });
		return;
	}
	await rpc.request.channelsSetCredential({ key: "IMESSAGE_ENABLED", value: "true" });
}

function ChannelCardHeader({
	channel,
	expanded,
	isEnabled,
	toggleBusy,
	onToggleExpand,
	onToggleEnabled,
}: {
	channel: ChannelStatus;
	expanded: boolean;
	isEnabled: boolean;
	toggleBusy: boolean;
	onToggleExpand: () => void;
	onToggleEnabled: () => Promise<void> | void;
}) {
	return (
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
				disabled={toggleBusy || !channel.platformAvailable}
				onClick={onToggleEnabled}
				title={isEnabled ? `Disable ${channel.label}` : `Enable ${channel.label}`}
				aria-label={isEnabled ? `Disable ${channel.label}` : `Enable ${channel.label}`}
			>
				<span className="channel-toggle-knob" />
			</button>
		</div>
	);
}

function ChannelCardBody({
	channel,
	actionError,
	allKeys,
	busy,
	draft,
	reloading,
	onClearKey,
	onDraftChange,
	onReload,
	onSetKey,
	onSetSetting,
}: {
	channel: ChannelStatus;
	actionError: string | null;
	allKeys: string[];
	busy: string | null;
	draft: Record<string, string>;
	reloading: boolean;
	onClearKey: (key: string) => void;
	onDraftChange: Dispatch<SetStateAction<Record<string, string>>>;
	onReload: () => void;
	onSetKey: (key: string) => void;
	onSetSetting: (key: string, value: boolean) => void;
}) {
	return (
		<div className="channel-card-body">
			<ChannelAlerts channel={channel} actionError={actionError} />
			{channel.id === "imessage" && channel.pluginLoaded && <ImessageTccBanner />}
			{(channel.id === "telegram" || channel.id === "discord") && channel.liveStatus === "online" && (
				<OwnerPairingSection connector={channel.id} />
			)}
			{channel.id === "discord" && channel.liveStatus === "online" && <DiscordBackfillSection />}
			<ReplySettingsSection channel={channel} busy={busy} onSetSetting={onSetSetting} />
			{channel.id === "github" ? (
				<GitHubChannelDetails
					channel={channel}
					busy={busy}
					draft={draft}
					onClearKey={onClearKey}
					onDraftChange={onDraftChange}
					onSetKey={onSetKey}
				/>
			) : (
				<CredentialsSection
					allKeys={allKeys}
					busy={busy}
					channel={channel}
					draft={draft}
					onClearKey={onClearKey}
					onDraftChange={onDraftChange}
					onSetKey={onSetKey}
				/>
			)}
			<ChannelStatusSection channel={channel} reloading={reloading} onReload={onReload} />
			{channel.id !== "github" && (
				<section className="channel-card-section">
					<h4 className="channel-card-section-title">Recent activity (from trajectories)</h4>
					<ChannelHistory sourceId={channel.id} pluginLoaded={channel.pluginLoaded} />
				</section>
			)}
		</div>
	);
}

function ChannelAlerts({ channel, actionError }: { channel: ChannelStatus; actionError: string | null }) {
	return (
		<>
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
		</>
	);
}

function ReplySettingsSection({
	channel,
	busy,
	onSetSetting,
}: {
	channel: ChannelStatus;
	busy: string | null;
	onSetSetting: (key: string, value: boolean) => void;
}) {
	if (channel.id !== "discord" && channel.id !== "telegram") return null;
	const rows = channel.id === "discord"
		? [
			{ key: "DISCORD_AUTO_REPLY", label: "Auto reply", value: channel.autoReply ?? true },
			{ key: "DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS", label: "Only when addressed", value: channel.respondOnlyToMentions ?? false },
		]
		: [
			{ key: "TELEGRAM_AUTO_REPLY", label: "Auto reply", value: channel.autoReply ?? true },
		];
	return (
		<section className="channel-card-section">
			<h4 className="channel-card-section-title">Reply settings</h4>
			<div className="channel-setting-list">
				{rows.map((row) => (
					<ReplySettingRow
						key={row.key}
						busy={busy === row.key}
						label={row.label}
						settingKey={row.key}
						value={row.value}
						onSetSetting={onSetSetting}
					/>
				))}
			</div>
		</section>
	);
}

function ReplySettingRow({
	busy,
	label,
	settingKey,
	value,
	onSetSetting,
}: {
	busy: boolean;
	label: string;
	settingKey: string;
	value: boolean;
	onSetSetting: (key: string, value: boolean) => void;
}) {
	return (
		<div className="channel-setting-row">
			<div className="channel-setting-copy">
				<span className="channel-setting-label">{label}</span>
				<span className="hint">{settingKey}</span>
			</div>
			<button
				type="button"
				className={`channel-toggle ${value ? "on" : "off"}`}
				disabled={busy}
				onClick={() => onSetSetting(settingKey, !value)}
				aria-label={`${value ? "Disable" : "Enable"} ${label}`}
				title={`${value ? "Disable" : "Enable"} ${label}`}
			>
				<span className="channel-toggle-knob" />
			</button>
		</div>
	);
}

function CredentialsSection({
	allKeys,
	busy,
	channel,
	draft,
	onClearKey,
	onDraftChange,
	onSetKey,
}: {
	allKeys: string[];
	busy: string | null;
	channel: ChannelStatus;
	draft: Record<string, string>;
	onClearKey: (key: string) => void;
	onDraftChange: Dispatch<SetStateAction<Record<string, string>>>;
	onSetKey: (key: string) => void;
}) {
	if (allKeys.length === 0) return null;
	return (
		<section className="channel-card-section">
			<h4 className="channel-card-section-title">Credentials</h4>
			<div className="channel-creds">
				{allKeys.map((key) => (
					<CredentialRow
						key={key}
						busy={busy}
						channel={channel}
						draft={draft}
						credentialKey={key}
						onClearKey={onClearKey}
						onDraftChange={onDraftChange}
						onSetKey={onSetKey}
					/>
				))}
			</div>
		</section>
	);
}

function CredentialRow({
	busy,
	channel,
	credentialKey,
	draft,
	onClearKey,
	onDraftChange,
	onSetKey,
}: {
	busy: string | null;
	channel: ChannelStatus;
	credentialKey: string;
	draft: Record<string, string>;
	onClearKey: (key: string) => void;
	onDraftChange: Dispatch<SetStateAction<Record<string, string>>>;
	onSetKey: (key: string) => void;
}) {
	const required = channel.requiredVaultKeys.includes(credentialKey);
	const missing = channel.missingKeys.includes(credentialKey);
	return (
		<div className="channel-cred-row">
			<label className="channel-cred-label">
				<span className="form-label">{credentialKey}</span>
				<span className="hint">{required ? "required" : "optional"} · {missing ? "not set" : "stored"}</span>
			</label>
			<div className="row" style={{ gap: 6 }}>
				<input
					type="password"
					value={draft[credentialKey] ?? ""}
					onChange={(e) => onDraftChange((d) => ({ ...d, [credentialKey]: e.target.value }))}
					placeholder={missing ? "paste value…" : "(stored — paste to overwrite)"}
					className="pensieve-input"
					style={{ flex: 1 }}
				/>
				<button type="button" className="btn small" disabled={busy === credentialKey || !draft[credentialKey]} onClick={() => onSetKey(credentialKey)}>
					{busy === credentialKey ? "Saving…" : "Save"}
				</button>
				{!missing && (
					<button type="button" className="btn small ghost" disabled={busy === credentialKey} onClick={() => onClearKey(credentialKey)}>
						Clear
					</button>
				)}
			</div>
		</div>
	);
}

function ChannelStatusSection({
	channel,
	reloading,
	onReload,
}: {
	channel: ChannelStatus;
	reloading: boolean;
	onReload: () => void;
}) {
	return (
		<section className="channel-card-section">
			<div className="channel-card-section-row">
				<h4 className="channel-card-section-title">Status</h4>
				{channel.configured && !channel.pluginLoaded && (
					<button type="button" className="btn small" disabled={reloading} onClick={onReload}>
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
	);
}

function ChannelHistory({
	sourceId,
	pluginLoaded,
}: {
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
			const r = await rpc.request.activityTrajectoriesList({ source: sourceId, limit: 20 });
			setData(r);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, [sourceId]);

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

function summarizeCatchUp(result: ChannelsDiscordCatchUpResult | undefined): string {
	if (!result) return "missed reply scan finished";
	const firstError = result.errorDetails?.[0];
	const errorText = firstError ? ` · ${firstError.channelName ?? firstError.channelId}: ${firstError.error}` : "";
	return `${result.replied} replied · ${result.addressed} addressed · ${result.alreadyAnswered} already answered · ${result.errors} errors${errorText}`;
}

function DiscordBackfillSection() {
	const [guilds, setGuilds] = useState<Array<{ id: string; name: string; channels: Array<{ id: string; name: string; type: number }> }> | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [results, setResults] = useState<Record<string, string>>({});
	const [limit, setLimit] = useState(200);

	const load = useCallback(async () => {
		try {
			const r = await rpc.request.channelsDiscordGuilds({});
			setGuilds(r.guilds);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, []);

	useEffect(() => { void load(); }, [load]);

	const backfill = async (channelId: string) => {
		setBusy(channelId);
		setResults((r) => ({ ...r, [channelId]: "scheduling…" }));
		try {
			await rpc.request.channelsDiscordBackfill({ channelId, limit, force: false });
			setResults((r) => ({ ...r, [channelId]: `backfilling ${limit} msgs (running in background — check Activity > Trajectories for source=discord)` }));
		} catch (e) {
			setResults((r) => ({ ...r, [channelId]: `error: ${e instanceof Error ? e.message : String(e)}` }));
		} finally {
			setBusy(null);
		}
	};

	const catchUp = async (channelId: string) => {
		setBusy(`catchup:${channelId}`);
		setResults((r) => ({ ...r, [channelId]: "scheduling missed replies…" }));
		try {
			const response = await rpc.request.channelsDiscordCatchUp({ channelId, limit: Math.min(limit, 500), maxAgeHours: 24, wait: true });
			setResults((r) => ({ ...r, [channelId]: summarizeCatchUp(response.result) }));
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
									<button
										type="button"
										className="btn small"
										disabled={busy === `catchup:${c.id}`}
										onClick={() => catchUp(c.id)}
									>
										{busy === `catchup:${c.id}` ? "…" : "Reply missed"}
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

function ImessageTccBanner() {
	const [granted, setGranted] = useState<boolean | null>(null);
	const [opening, setOpening] = useState(false);

	useEffect(() => {
		rpc.request.osListPermissions({})
			.then((perms) => {
				const fda = perms.find((p) => p.id === "full-disk-access");
				setGranted(fda?.status === "granted");
			})
			.catch(() => setGranted(null));
	}, []);

	if (granted === true) {
		return (
			<div className="banner ok" style={{ marginBottom: 8, fontSize: 12 }}>
				✓ Full Disk Access granted — Detour can read your iMessages.
			</div>
		);
	}
	const open = async () => {
		setOpening(true);
		try { await rpc.request.osOpenPermissionPane({ id: "full-disk-access" }); }
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

/**
 * Owner-binding section for Telegram + Discord cards.
 * Issues a 6-digit pair code and walks the user through `/eliza_pair <code>`
 * (Telegram) or `/eliza-pair <code>` (Discord) on their connector. Once the
 * connector backend reports success, shows the bound owner identity and an
 * Unbind button.
 */
function OwnerPairingSection({
	connector,
}: {
	connector: "telegram" | "discord";
}) {
	const [bound, setBound] = useState<{ externalId: string; displayHandle: string } | null>(null);
	const [code, setCode] = useState<string | null>(null);
	const [expiresAt, setExpiresAt] = useState<number | null>(null);
	const [now, setNow] = useState(Date.now());
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			const status = await rpc.request.ownerBindStatus({ connector });
			setBound(status.owner);
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		}
	}, [connector]);

	useEffect(() => {
		void refresh();
		const t = setInterval(refresh, 5000);
		return () => clearInterval(t);
	}, [refresh]);

	useEffect(() => {
		if (!expiresAt) return;
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, [expiresAt]);

	const generate = useCallback(async () => {
		setBusy(true);
		setErr(null);
		try {
			const r = await rpc.request.ownerBindGenerateCode({ connector });
			setCode(r.code);
			setExpiresAt(r.expiresAt);
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}, [connector]);

	const unbind = useCallback(async () => {
		if (!confirm(`Unbind ${connector} owner?`)) return;
		setBusy(true);
		setErr(null);
		try {
			await rpc.request.ownerBindUnbind({ connector });
			await refresh();
			setCode(null);
			setExpiresAt(null);
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}, [connector, refresh]);

	const slashCmd = connector === "telegram" ? "/eliza_pair" : "/eliza-pair";
	const where = connector === "telegram"
		? "Open Telegram, find @detour_squrriel_bot (or your bot), and send:"
		: "Open Discord, DM the bot in any guild it's in, and send:";

	const remaining = expiresAt ? Math.max(0, Math.floor((expiresAt - now) / 1000)) : 0;
	const expired = expiresAt !== null && remaining === 0;

	return (
		<section className="channel-card-section">
			<h4 className="channel-card-section-title">Owner pairing</h4>
			{err && <div className="banner error" style={{ marginBottom: 8 }}>{err}</div>}
			{bound ? (
				<div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
					<span className="badge ok">paired</span>
					<span className="hint" style={{ flex: 1 }}>
						{bound.displayHandle} <span style={{ opacity: 0.6 }}>(id {bound.externalId})</span>
					</span>
					<button type="button" className="btn small ghost" disabled={busy} onClick={unbind}>
						Unbind
					</button>
				</div>
			) : (
				<>
					<div className="hint" style={{ marginBottom: 8, lineHeight: 1.5 }}>
						Prove your {connector} account is the owner of this Detour install. Generate a one-time
						code, then send <code>{slashCmd} &lt;code&gt;</code> from your account to the bot.
					</div>
					{code ? (
						<div style={{ display: "grid", gap: 8 }}>
							<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
								<code style={{ fontSize: 22, letterSpacing: 4, padding: "6px 12px", background: "var(--bg-elevated)", borderRadius: 6 }}>
									{code}
								</code>
								<button
									type="button"
									className="btn small ghost"
									onClick={() => {
										try { navigator.clipboard.writeText(code); } catch { /* noop */ }
									}}
								>
									Copy
								</button>
								<span className={`hint ${expired ? "err" : ""}`} style={{ marginLeft: "auto" }}>
									{expired ? "expired" : `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")} left`}
								</span>
							</div>
							<div className="hint" style={{ lineHeight: 1.5 }}>
								{where} <code>{slashCmd} {code}</code>
							</div>
							{expired && (
								<button type="button" className="btn small" onClick={generate}>
									Generate a new code
								</button>
							)}
						</div>
					) : (
						<button type="button" className="btn small primary" disabled={busy} onClick={generate}>
							{busy ? "Generating…" : `Generate ${connector} pair code`}
						</button>
					)}
				</>
			)}
		</section>
	);
}

// ── GitHub channel: agent/user split ──────────────────────────────────

const GITHUB_ROLE_META: Record<GitHubChannelRole, { title: string; vaultKey: string; description: string; activityHeader: string; activityHint: string }> = {
	agent: {
		title: "Agent identity",
		vaultKey: "GITHUB_AGENT_PAT",
		description: "The bot's PAT. Used by detour-driven actions: opening PRs, leaving review comments, triaging issues. Recent activity shows what the agent has done on GitHub.",
		activityHeader: "Recent agent activity",
		activityHint: "From /users/<agent>/events — what this PAT has been doing on GitHub.",
	},
	user: {
		title: "User identity",
		vaultKey: "GITHUB_USER_PAT",
		description: "Your personal PAT. Used to read your inbox: notifications, review requests, mentions, assigned issues. Recent activity surfaces what GitHub is pinging you about.",
		activityHeader: "Recent user activity",
		activityHint: "From /notifications — what GitHub is asking for your attention on.",
	},
};

function GitHubChannelDetails({
	channel,
	busy,
	draft,
	onClearKey,
	onDraftChange,
	onSetKey,
}: {
	channel: ChannelStatus;
	busy: string | null;
	draft: Record<string, string>;
	onClearKey: (key: string) => void;
	onDraftChange: Dispatch<SetStateAction<Record<string, string>>>;
	onSetKey: (key: string) => void;
}) {
	return (
		<>
			<GitHubRoleSection role="agent" channel={channel} busy={busy} draft={draft} onClearKey={onClearKey} onDraftChange={onDraftChange} onSetKey={onSetKey} />
			<GitHubRoleSection role="user" channel={channel} busy={busy} draft={draft} onClearKey={onClearKey} onDraftChange={onDraftChange} onSetKey={onSetKey} />
			<GitHubLegacyTokenSection channel={channel} busy={busy} draft={draft} onClearKey={onClearKey} onDraftChange={onDraftChange} onSetKey={onSetKey} />
		</>
	);
}

function GitHubRoleSection({
	role,
	channel,
	busy,
	draft,
	onClearKey,
	onDraftChange,
	onSetKey,
}: {
	role: GitHubChannelRole;
	channel: ChannelStatus;
	busy: string | null;
	draft: Record<string, string>;
	onClearKey: (key: string) => void;
	onDraftChange: Dispatch<SetStateAction<Record<string, string>>>;
	onSetKey: (key: string) => void;
}) {
	const meta = GITHUB_ROLE_META[role];
	const [identity, setIdentity] = useState<GitHubIdentity | null>(null);
	const [identityError, setIdentityError] = useState<string | null>(null);
	const [identityChecking, setIdentityChecking] = useState(false);

	const refreshIdentity = useCallback(async () => {
		setIdentityChecking(true);
		try {
			const r = await rpc.request.githubIdentity({ role });
			setIdentity(r.identity);
			setIdentityError(r.error ?? null);
		} catch (e) {
			setIdentityError(e instanceof Error ? e.message : String(e));
			setIdentity(null);
		} finally {
			setIdentityChecking(false);
		}
	}, [role]);

	useEffect(() => { void refreshIdentity(); }, [refreshIdentity]);

	return (
		<section className="channel-card-section github-role-section">
			<div className="github-role-head">
				<div>
					<h4 className="channel-card-section-title">{meta.title}</h4>
					<p className="hint" style={{ margin: "2px 0 0" }}>{meta.description}</p>
				</div>
				<GitHubIdentityBadge identity={identity} error={identityError} checking={identityChecking} onRefresh={refreshIdentity} />
			</div>
			<CredentialRow
				busy={busy}
				channel={channel}
				credentialKey={meta.vaultKey}
				draft={draft}
				onClearKey={(k) => { onClearKey(k); setTimeout(() => void refreshIdentity(), 400); }}
				onDraftChange={onDraftChange}
				onSetKey={(k) => { onSetKey(k); setTimeout(() => void refreshIdentity(), 400); }}
			/>
			<div className="github-activity-block">
				<div className="channel-card-section-row">
					<h5 className="github-activity-title">{meta.activityHeader}</h5>
					<span className="hint">{meta.activityHint}</span>
				</div>
				<GitHubActivityFeed role={role} hasPat={Boolean(identity)} />
			</div>
		</section>
	);
}

function GitHubIdentityBadge({
	identity,
	error,
	checking,
	onRefresh,
}: {
	identity: GitHubIdentity | null;
	error: string | null;
	checking: boolean;
	onRefresh: () => void;
}) {
	if (checking && !identity) return <span className="badge muted" style={{ fontSize: 11 }}>checking…</span>;
	if (error) {
		return (
			<button type="button" className="badge err github-identity-badge" onClick={onRefresh} title={error}>
				token error
			</button>
		);
	}
	if (!identity) return <span className="badge muted" style={{ fontSize: 11 }}>not signed in</span>;
	return (
		<button type="button" className="github-identity-badge" onClick={onRefresh} title={`@${identity.login}`}>
			{identity.avatarUrl && <img src={identity.avatarUrl} alt="" width={20} height={20} />}
			<span>@{identity.login}</span>
		</button>
	);
}

function GitHubActivityFeed({ role, hasPat }: { role: GitHubChannelRole; hasPat: boolean }) {
	const [events, setEvents] = useState<GitHubActivityEvent[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	const load = useCallback(async () => {
		if (!hasPat) { setEvents([]); setError(null); return; }
		setLoading(true);
		setError(null);
		try {
			const r = await rpc.request.githubRecentActivity({ role, limit: 12 });
			setEvents(r.events);
			setError(r.error ?? null);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, [hasPat, role]);

	useEffect(() => {
		void load();
		if (!hasPat) return;
		const t = setInterval(load, 30_000);
		return () => clearInterval(t);
	}, [load, hasPat]);

	if (!hasPat) return <div className="empty" style={{ padding: 8 }}>Configure the {role === "agent" ? "agent" : "user"} PAT to see activity.</div>;
	if (error) return <div className="banner error">{error}</div>;
	if (loading && events.length === 0) return <div className="hint" style={{ padding: 6 }}>Loading…</div>;
	if (events.length === 0) return <div className="empty" style={{ padding: 8 }}>No recent activity.</div>;
	return (
		<div className="github-activity-list">
			{events.map((e) => <GitHubActivityRow key={e.id} event={e} />)}
		</div>
	);
}

function GitHubActivityRow({ event }: { event: GitHubActivityEvent }) {
	const onClick = () => {
		if (!event.htmlUrl) return;
		void rpc.request.externalOpen({ url: event.htmlUrl });
	};
	return (
		<button
			type="button"
			className={`github-activity-row ${event.htmlUrl ? "clickable" : ""}`}
			onClick={onClick}
			disabled={!event.htmlUrl}
		>
			<span className="github-activity-type">{event.type.replace(/Event$/, "")}</span>
			<span className="github-activity-summary">{event.summary}</span>
			<span className="github-activity-time">{relativeGitHubTime(event.createdAt)}</span>
		</button>
	);
}

function relativeGitHubTime(iso: string): string {
	try {
		const ts = new Date(iso).getTime();
		const sec = Math.max(1, Math.round((Date.now() - ts) / 1000));
		if (sec < 60) return `${sec}s`;
		if (sec < 3600) return `${Math.round(sec / 60)}m`;
		if (sec < 86400) return `${Math.round(sec / 3600)}h`;
		return `${Math.round(sec / 86400)}d`;
	} catch {
		return iso;
	}
}

function GitHubLegacyTokenSection({
	channel,
	busy,
	draft,
	onClearKey,
	onDraftChange,
	onSetKey,
}: {
	channel: ChannelStatus;
	busy: string | null;
	draft: Record<string, string>;
	onClearKey: (key: string) => void;
	onDraftChange: Dispatch<SetStateAction<Record<string, string>>>;
	onSetKey: (key: string) => void;
}) {
	if (!channel.optionalVaultKeys.includes("GITHUB_TOKEN")) return null;
	const present = !channel.missingKeys.includes("GITHUB_TOKEN");
	return (
		<section className="channel-card-section">
			<h4 className="channel-card-section-title">Legacy fallback (GITHUB_TOKEN)</h4>
			<p className="hint" style={{ marginTop: 0 }}>
				Optional single-token fallback used when role-specific PATs aren't set. {present ? "Currently set." : "Not set."}
			</p>
			<CredentialRow
				busy={busy}
				channel={channel}
				credentialKey="GITHUB_TOKEN"
				draft={draft}
				onClearKey={onClearKey}
				onDraftChange={onDraftChange}
				onSetKey={onSetKey}
			/>
		</section>
	);
}
