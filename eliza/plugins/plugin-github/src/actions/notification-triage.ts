/**
 * @module notification-triage
 * @description Fetches unread GitHub notifications and returns them sorted
 * by a composite priority score derived from `reason`, subject type, and
 * the notifying repo's `pushed_at` freshness.
 *
 * Read-only — no confirmation gate.
 */

import type {
  Action,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { buildResolvedClient, getAuthenticatedLogin, isSameLogin, resolveIdentity } from "../action-helpers.js";
import {
  errorMessage,
  formatRateLimitMessage,
  inspectRateLimit,
} from "../rate-limit.js";
import { type GitHubActionResult, GitHubActions } from "../types.js";

const REASON_SCORES: Record<string, number> = {
  security_advisory: 100,
  team_mention: 70,
  author: 60,
  mention: 55,
  assign: 50,
  review_requested: 80,
  state_change: 20,
  comment: 30,
  subscribed: 10,
  manual: 15,
  invitation: 40,
  ci_activity: 25,
};

const SUBJECT_TYPE_SCORES: Record<string, number> = {
  PullRequest: 20,
  Issue: 15,
  Release: 10,
  Commit: 5,
  Discussion: 8,
};

export interface TriagedNotification {
  id: string;
  reason: string;
  repo: string;
  title: string;
  subjectType: string;
  url: string | null;
  updatedAt: string;
  score: number;
}

function scoreNotification(params: {
  reason: string;
  subjectType: string;
  repoPushedAtMs: number | null;
  nowMs: number;
}): number {
  const base = REASON_SCORES[params.reason] ?? 10;
  const subject = SUBJECT_TYPE_SCORES[params.subjectType] ?? 0;
  let freshness = 0;
  if (params.repoPushedAtMs !== null) {
    const ageHours = (params.nowMs - params.repoPushedAtMs) / (1000 * 60 * 60);
    if (ageHours < 1) freshness = 20;
    else if (ageHours < 6) freshness = 15;
    else if (ageHours < 24) freshness = 10;
    else if (ageHours < 24 * 7) freshness = 5;
  }
  return base + subject + freshness;
}

export { scoreNotification };

export const notificationTriageAction: Action = {
  name: GitHubActions.GITHUB_NOTIFICATION_TRIAGE,
  similes: ["TRIAGE_GITHUB_NOTIFICATIONS", "GITHUB_INBOX"],
  description:
    "Returns unread GitHub notifications sorted by a priority score derived from reason, subject type, and repo freshness.",
  descriptionCompressed:
    "return unread GitHub notification sort priority score derive reason, subject type, repo freshness",

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
  ): Promise<boolean> => {
    const r = buildResolvedClient(runtime, "user");
    return !("error" in r);
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<GitHubActionResult<{ notifications: TriagedNotification[] }>> => {
    const identity = resolveIdentity(options, "user");
    const resolved = buildResolvedClient(runtime, identity);
    if ("error" in resolved) {
      await callback?.({ text: resolved.error });
      return { success: false, error: resolved.error };
    }

    try {
      const [resp, selfLogin] = await Promise.all([
        resolved.client.activity.listNotificationsForAuthenticatedUser({
          all: false,
          per_page: 50,
        }),
        getAuthenticatedLogin(runtime, identity),
      ]);
      const notifications = resp.data as Array<{
        id: string;
        reason?: string | null;
        repository?: { full_name?: string | null; pushed_at?: string | null };
        subject?: {
          title?: string | null;
          type?: string | null;
          url?: string | null;
          latest_comment_url?: string | null;
        };
        updated_at: string;
      }>;
      // Self-loop filter: drop notifications where the most recent
      // actor is the authenticated identity itself. Skips events the
      // agent triggered, so it can't endlessly react to its own
      // comments/PRs. We only filter when latest_comment_url is set
      // and resolves cleanly; failures fall through (fail-open).
      const filteredNotifications: typeof notifications = [];
      if (!selfLogin) {
        filteredNotifications.push(...notifications);
      } else {
        await Promise.all(
          notifications.map(async (n) => {
            const latestUrl = n.subject?.latest_comment_url;
            if (!latestUrl || typeof latestUrl !== "string") {
              filteredNotifications.push(n);
              return;
            }
            try {
              const r = await resolved.client.request(`GET ${latestUrl.replace("https://api.github.com", "")}`);
              const author = (r.data as { user?: { login?: string } })?.user?.login ?? null;
              if (!isSameLogin(author, selfLogin)) filteredNotifications.push(n);
            } catch {
              filteredNotifications.push(n);
            }
          }),
        );
      }
      const nowMs = Date.now();
      const triaged: TriagedNotification[] = filteredNotifications.map((n) => {
        const repoPushedAt = n.repository?.pushed_at ?? null;
        const repoPushedAtMs =
          typeof repoPushedAt === "string" ? Date.parse(repoPushedAt) : null;
        const reason = typeof n.reason === "string" ? n.reason : "unknown";
        const subjectType =
          typeof n.subject?.type === "string" ? n.subject.type : "Unknown";
        return {
          id: n.id,
          reason,
          repo: n.repository?.full_name ?? "unknown",
          title: n.subject?.title ?? "(untitled)",
          subjectType,
          url: n.subject?.url ?? null,
          updatedAt: n.updated_at,
          score: scoreNotification({
            reason,
            subjectType,
            repoPushedAtMs:
              repoPushedAtMs !== null && Number.isFinite(repoPushedAtMs)
                ? repoPushedAtMs
                : null,
            nowMs,
          }),
        };
      });
      triaged.sort((a, b) => b.score - a.score);
      await callback?.({
        text: `Triaged ${triaged.length} unread notification(s)`,
      });
      return { success: true, data: { notifications: triaged } };
    } catch (err) {
      const rl = inspectRateLimit(err);
      const message = rl.isRateLimited
        ? formatRateLimitMessage(rl)
        : `GITHUB_NOTIFICATION_TRIAGE failed: ${errorMessage(err)}`;
      logger.warn({ message }, "[GitHub:GITHUB_NOTIFICATION_TRIAGE]");
      await callback?.({ text: message });
      return { success: false, error: message };
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "What's in my GitHub inbox?" },
      },
      {
        name: "{{agentName}}",
        content: { text: "Triaged 7 unread notification(s)" },
      },
    ],
  ],
};
