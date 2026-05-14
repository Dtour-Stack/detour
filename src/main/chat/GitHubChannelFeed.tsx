/**
 * GitHub-specific replacement for the gateway-feed view inside the
 * chat hub. The gateway feed only carries chat-shaped messages; GitHub
 * traffic is event-shaped (PRs, comments, notifications), so we render
 * two stacked panels (Agent + User) with identity headers and live
 * activity lists pulled from the GitHub REST API.
 *
 * Read-only; credential editing lives in Messaging connections.
 */

import { useCallback, useEffect, useState } from "react";
import type { ChannelStatus } from "../../shared/index";
import type { GitHubActivityEvent, GitHubChannelRole, GitHubIdentity } from "../../shared/rpc/github-channel";
import { rpc } from "../rpc";

const ROLE_META: Record<GitHubChannelRole, { title: string; subtitle: string }> = {
	agent: { title: "Agent", subtitle: "Bot identity · what the agent has done on GitHub." },
	user: { title: "You", subtitle: "Your identity · notifications, mentions, review requests." },
};

export function GitHubChannelFeed({ channel: _channel }: { channel: ChannelStatus }) {
	return (
		<div className="hub-channel hub-github">
			<header className="hub-channel-header">
				<div>
					<h2>GitHub</h2>
					<div className="hint">Two-paned view: agent activity (top) + your inbox (bottom).</div>
				</div>
			</header>
			<div className="hub-github-panels">
				<GitHubRolePanel role="agent" />
				<GitHubRolePanel role="user" />
			</div>
		</div>
	);
}

function GitHubRolePanel({ role }: { role: GitHubChannelRole }) {
	const meta = ROLE_META[role];
	const [identity, setIdentity] = useState<GitHubIdentity | null>(null);
	const [identityError, setIdentityError] = useState<string | null>(null);
	const [events, setEvents] = useState<GitHubActivityEvent[]>([]);
	const [feedError, setFeedError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const idRes = await rpc.request.githubIdentity({ role });
			setIdentity(idRes.identity);
			setIdentityError(idRes.error ?? null);
			if (!idRes.identity) {
				setEvents([]);
				setFeedError(null);
				return;
			}
			const actRes = await rpc.request.githubRecentActivity({ role, limit: 15 });
			setEvents(actRes.events);
			setFeedError(actRes.error ?? null);
		} catch (e) {
			setFeedError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, [role]);

	useEffect(() => {
		void load();
		const t = setInterval(load, 30_000);
		return () => clearInterval(t);
	}, [load]);

	return (
		<section className="hub-github-panel">
			<header className="hub-github-panel-head">
				<div className="hub-github-panel-meta">
					<h3>{meta.title}</h3>
					<span className="hint">{meta.subtitle}</span>
				</div>
				<GitHubBadge identity={identity} error={identityError} loading={loading} onRefresh={load} />
			</header>
			<GitHubFeed
				role={role}
				identity={identity}
				events={events}
				error={feedError}
				loading={loading}
			/>
		</section>
	);
}

function GitHubBadge({
	identity,
	error,
	loading,
	onRefresh,
}: {
	identity: GitHubIdentity | null;
	error: string | null;
	loading: boolean;
	onRefresh: () => void;
}) {
	if (loading && !identity) return <span className="badge muted" style={{ fontSize: 11 }}>checking…</span>;
	if (error) return <button type="button" className="badge err" onClick={onRefresh} title={error}>token error</button>;
	if (!identity) {
		return (
			<button
				type="button"
				className="badge muted"
				onClick={() => rpc.request.workspaceOpen({}).catch(() => {})}
				title="Configure in Messaging connections"
			>
				not signed in
			</button>
		);
	}
	return (
		<button
			type="button"
			className="hub-github-identity"
			onClick={() => rpc.request.externalOpen({ url: identity.htmlUrl })}
			title={identity.htmlUrl}
		>
			{identity.avatarUrl && <img src={identity.avatarUrl} alt="" width={20} height={20} />}
			<span>@{identity.login}</span>
		</button>
	);
}

function GitHubFeed({
	role,
	identity,
	events,
	error,
	loading,
}: {
	role: GitHubChannelRole;
	identity: GitHubIdentity | null;
	events: GitHubActivityEvent[];
	error: string | null;
	loading: boolean;
}) {
	if (!identity) {
		return (
			<div className="empty" style={{ padding: 16 }}>
				No PAT configured for the {role} identity. Wire it in Messaging connections.
			</div>
		);
	}
	if (error) return <div className="banner error" style={{ margin: 8 }}>{error}</div>;
	if (loading && events.length === 0) return <div className="hint" style={{ padding: 16 }}>Loading…</div>;
	if (events.length === 0) {
		return (
			<div className="empty" style={{ padding: 16 }}>
				{role === "agent" ? "No recent agent activity." : "Inbox is empty."}
			</div>
		);
	}
	return (
		<ul className="hub-github-list">
			{events.map((e) => (
				<li key={e.id} className="hub-github-item">
					<button
						type="button"
						className={`hub-github-item-btn ${e.htmlUrl ? "clickable" : ""}`}
						onClick={() => { if (e.htmlUrl) void rpc.request.externalOpen({ url: e.htmlUrl }); }}
						disabled={!e.htmlUrl}
					>
						<span className="hub-github-type">{e.type.replace(/Event$/, "")}</span>
						<span className="hub-github-summary">{e.summary}</span>
						<span className="hub-github-time">{relTime(e.createdAt)}</span>
					</button>
				</li>
			))}
		</ul>
	);
}

function relTime(iso: string): string {
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
