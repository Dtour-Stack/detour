/**
 * GitHub channel RPC handlers — back the agent/user split UI in the
 * Channels view. Reads the role-specific PAT from vault, calls the
 * GitHub REST API directly (no plugin dependency).
 *
 * Network calls are short-bounded (5s) to keep the channel card UI
 * snappy when the network is offline.
 */

import type {
	GitHubActivityEvent,
	GitHubChannelRole,
	GitHubIdentity,
} from "../../../../shared/rpc/github-channel";
import type { RpcDeps } from "../types";

const GITHUB_API = "https://api.github.com";
const GH_TIMEOUT_MS = 5000;
const GH_HEADERS_BASE = {
	Accept: "application/vnd.github+json",
	"X-GitHub-Api-Version": "2022-11-28",
} as const;

async function ghFetch(path: string, token: string): Promise<Response> {
	const ctl = new AbortController();
	const t = setTimeout(() => ctl.abort(), GH_TIMEOUT_MS);
	try {
		return await fetch(`${GITHUB_API}${path}`, {
			headers: { ...GH_HEADERS_BASE, Authorization: `Bearer ${token}` },
			signal: ctl.signal,
		});
	} finally {
		clearTimeout(t);
	}
}

async function getRolePat(deps: RpcDeps, role: GitHubChannelRole): Promise<string | null> {
	const v = await deps.vault.vault();
	const primary = role === "agent" ? "GITHUB_AGENT_PAT" : "GITHUB_USER_PAT";
	const fallback = "GITHUB_TOKEN";
	const fromPrimary = await v.get(primary).catch(() => "");
	if (typeof fromPrimary === "string" && fromPrimary.length > 0) return fromPrimary;
	const fromFallback = await v.get(fallback).catch(() => "");
	if (typeof fromFallback === "string" && fromFallback.length > 0) return fromFallback;
	return null;
}

function summarizeEvent(e: { type?: string; payload?: Record<string, unknown>; repo?: { name?: string } }): { summary: string; htmlUrl: string | null } {
	const p = (e.payload ?? {}) as Record<string, unknown>;
	const repo = e.repo?.name ?? "";
	switch (e.type) {
		case "PushEvent": {
			const branchRef = typeof p.ref === "string" ? p.ref.replace("refs/heads/", "") : "?";
			const commits = Array.isArray(p.commits) ? p.commits.length : 0;
			return { summary: `pushed ${commits} commit(s) to ${repo}@${branchRef}`, htmlUrl: repo ? `https://github.com/${repo}/commits/${branchRef}` : null };
		}
		case "PullRequestEvent": {
			const action = String(p.action ?? "updated");
			const pr = (p.pull_request ?? {}) as Record<string, unknown>;
			const num = pr.number ?? "?";
			const title = pr.title ?? "(no title)";
			const url = typeof pr.html_url === "string" ? pr.html_url : null;
			return { summary: `${action} PR #${num} in ${repo}: ${title}`, htmlUrl: url };
		}
		case "PullRequestReviewEvent":
		case "PullRequestReviewCommentEvent": {
			const pr = (p.pull_request ?? {}) as Record<string, unknown>;
			const url = typeof pr.html_url === "string" ? pr.html_url : null;
			return { summary: `reviewed PR #${pr.number ?? "?"} in ${repo}`, htmlUrl: url };
		}
		case "IssuesEvent": {
			const action = String(p.action ?? "updated");
			const iss = (p.issue ?? {}) as Record<string, unknown>;
			const url = typeof iss.html_url === "string" ? iss.html_url : null;
			return { summary: `${action} issue #${iss.number ?? "?"} in ${repo}: ${iss.title ?? ""}`, htmlUrl: url };
		}
		case "IssueCommentEvent": {
			const iss = (p.issue ?? {}) as Record<string, unknown>;
			const url = typeof iss.html_url === "string" ? iss.html_url : null;
			return { summary: `commented on #${iss.number ?? "?"} in ${repo}`, htmlUrl: url };
		}
		case "CreateEvent":
			return { summary: `created ${p.ref_type ?? "ref"} ${p.ref ?? ""} in ${repo}`.trim(), htmlUrl: repo ? `https://github.com/${repo}` : null };
		case "DeleteEvent":
			return { summary: `deleted ${p.ref_type ?? "ref"} ${p.ref ?? ""} in ${repo}`.trim(), htmlUrl: null };
		case "WatchEvent":
			return { summary: `starred ${repo}`, htmlUrl: repo ? `https://github.com/${repo}` : null };
		case "ForkEvent":
			return { summary: `forked ${repo}`, htmlUrl: repo ? `https://github.com/${repo}` : null };
		default:
			return { summary: `${e.type ?? "Event"} in ${repo}`.trim(), htmlUrl: repo ? `https://github.com/${repo}` : null };
	}
}

function summarizeNotification(n: Record<string, unknown>): { summary: string; htmlUrl: string | null; type: string; createdAt: string; id: string } {
	const subj = (n.subject ?? {}) as Record<string, unknown>;
	const repo = (n.repository ?? {}) as Record<string, unknown>;
	const type = typeof subj.type === "string" ? subj.type : "Notification";
	const reason = typeof n.reason === "string" ? n.reason : "";
	const title = typeof subj.title === "string" ? subj.title : "(no title)";
	const repoName = typeof repo.full_name === "string" ? repo.full_name : "";
	const apiUrl = typeof subj.url === "string" ? subj.url : null;
	// Convert API URL → html URL when possible (best-effort).
	const htmlUrl = apiUrl
		? apiUrl.replace("https://api.github.com/repos/", "https://github.com/").replace("/pulls/", "/pull/")
		: null;
	const summary = `${reason ? `[${reason}] ` : ""}${title}${repoName ? ` (${repoName})` : ""}`;
	return {
		id: typeof n.id === "string" ? n.id : Math.random().toString(36).slice(2),
		type,
		summary,
		htmlUrl,
		createdAt: typeof n.updated_at === "string" ? n.updated_at : new Date().toISOString(),
	};
}

export function githubChannelRequests(deps: RpcDeps) {
	return {
		githubIdentity: async ({ role }: { role: GitHubChannelRole }): Promise<{ identity: GitHubIdentity | null; error?: string }> => {
			const pat = await getRolePat(deps, role);
			if (!pat) return { identity: null };
			try {
				const res = await ghFetch("/user", pat);
				if (!res.ok) {
					const body = await res.text().catch(() => res.statusText);
					return { identity: null, error: `HTTP ${res.status}: ${body.slice(0, 160)}` };
				}
				const j = (await res.json()) as { login?: string; name?: string | null; avatar_url?: string | null; html_url?: string };
				if (!j.login) return { identity: null, error: "no login in /user response" };
				return {
					identity: {
						login: j.login,
						name: j.name ?? null,
						avatarUrl: j.avatar_url ?? null,
						htmlUrl: j.html_url ?? `https://github.com/${j.login}`,
					},
				};
			} catch (err) {
				return { identity: null, error: err instanceof Error ? err.message : String(err) };
			}
		},

		githubRecentActivity: async (
			{ role, limit = 12 }: { role: GitHubChannelRole; limit?: number },
		): Promise<{ events: GitHubActivityEvent[]; error?: string }> => {
			const pat = await getRolePat(deps, role);
			if (!pat) return { events: [] };
			const cap = Math.max(1, Math.min(50, Math.round(limit)));
			try {
				if (role === "user") {
					const res = await ghFetch(`/notifications?per_page=${cap}`, pat);
					if (!res.ok) {
						const body = await res.text().catch(() => res.statusText);
						return { events: [], error: `HTTP ${res.status}: ${body.slice(0, 160)}` };
					}
					const arr = (await res.json()) as Array<Record<string, unknown>>;
					const events: GitHubActivityEvent[] = [];
					for (const n of arr) {
						const s = summarizeNotification(n);
						const repo = (n.repository ?? {}) as Record<string, unknown>;
						events.push({
							id: s.id,
							type: s.type,
							repo: typeof repo.full_name === "string" ? repo.full_name : null,
							createdAt: s.createdAt,
							summary: s.summary,
							htmlUrl: s.htmlUrl,
						});
					}
					return { events };
				}
				// Agent role — pull /users/<login>/events to show what the bot did.
				const meRes = await ghFetch("/user", pat);
				if (!meRes.ok) {
					const body = await meRes.text().catch(() => meRes.statusText);
					return { events: [], error: `identity check failed: HTTP ${meRes.status}: ${body.slice(0, 160)}` };
				}
				const me = (await meRes.json()) as { login?: string };
				if (!me.login) return { events: [], error: "no login in /user response" };
				const evRes = await ghFetch(`/users/${me.login}/events?per_page=${cap}`, pat);
				if (!evRes.ok) {
					const body = await evRes.text().catch(() => evRes.statusText);
					return { events: [], error: `HTTP ${evRes.status}: ${body.slice(0, 160)}` };
				}
				const arr = (await evRes.json()) as Array<{ id?: string; type?: string; payload?: Record<string, unknown>; repo?: { name?: string }; created_at?: string }>;
				const events: GitHubActivityEvent[] = [];
				for (const e of arr) {
					const { summary, htmlUrl } = summarizeEvent(e);
					events.push({
						id: e.id ?? Math.random().toString(36).slice(2),
						type: e.type ?? "Event",
						repo: e.repo?.name ?? null,
						createdAt: e.created_at ?? new Date().toISOString(),
						summary,
						htmlUrl,
					});
				}
				return { events };
			} catch (err) {
				return { events: [], error: err instanceof Error ? err.message : String(err) };
			}
		},
	};
}
