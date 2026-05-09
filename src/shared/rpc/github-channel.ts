/**
 * GitHub channel RPC — shared by the GitHub channel card UI to render
 * separate "Agent" and "User" sections, each with its own identity
 * header and recent-activity feed.
 *
 *   - Agent role uses GITHUB_AGENT_PAT (the bot's PAT). Recent activity
 *     comes from `GET /users/<login>/events` so we see what the bot has
 *     done on GitHub (PRs, comments, issues opened).
 *   - User role uses GITHUB_USER_PAT (the human's PAT). Recent activity
 *     comes from `GET /notifications` so the user sees what GitHub is
 *     pinging them about (review requests, mentions, assigned issues).
 *
 * Both fall back to GITHUB_TOKEN when the role-specific PAT isn't set,
 * so a user with only the legacy single-token setup still gets a UI.
 */

export type GitHubChannelRole = "agent" | "user";

export type GitHubIdentity = {
	login: string;
	name: string | null;
	avatarUrl: string | null;
	htmlUrl: string;
};

export type GitHubActivityEvent = {
	id: string;
	type: string; // "PushEvent" | "PullRequestEvent" | "IssueCommentEvent" | …
	repo: string | null;
	createdAt: string; // ISO
	summary: string; // human-friendly one-liner
	htmlUrl: string | null;
};

export type GitHubChannelRequests = {
	githubIdentity: {
		params: { role: GitHubChannelRole };
		response: { identity: GitHubIdentity | null; error?: string };
	};
	githubRecentActivity: {
		params: { role: GitHubChannelRole; limit?: number };
		response: { events: GitHubActivityEvent[]; error?: string };
	};
};
