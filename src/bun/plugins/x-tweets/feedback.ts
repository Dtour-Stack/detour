/** Engagement feedback summarizer.
 *
 * Pure leaf formatter: no imports from Detour modules, no process.env,
 * no I/O, no side effects. Takes all context as parameters so tests stay
 * deterministic.
 *
 * Scoring follows the open-source X ranker weighting:
 *   score = replies * 3 + reposts * 2 + likes * 0.5
 *
 * ASCII punctuation only -- no em dashes or en dashes anywhere.
 */

export interface PostEngagement {
  text: string;
  replyCount: number;
  retweetCount: number;
  favoriteCount: number;
}

export interface EngagementSummary {
  topPatterns: string[];
  flops: string[];
}

function engagementScore(post: PostEngagement): number {
  return post.replyCount * 3 + post.retweetCount * 2 + post.favoriteCount * 0.5;
}

/** Rank posts by conversation-weighted score (replies and reposts weighted above
 *  likes). Return the texts of the top performers in topPatterns and the lowest
 *  scorers in flops. No post appears in both lists. */
export function summarizeEngagement(posts: PostEngagement[]): EngagementSummary {
  const n = posts.length;
  if (n === 0) return { topPatterns: [], flops: [] };

  // Sort descending by score; preserve original order on ties via stable sort.
  const sorted = posts
    .map((p, i) => ({ post: p, score: engagementScore(p), idx: i }))
    .sort((a, b) => b.score - a.score || a.idx - b.idx);

  // k is the count of top performers AND flops. Guaranteed no-overlap:
  // take top-k from the front, flops from the back, capped at floor(n/2).
  if (n === 1) {
    return { topPatterns: [sorted[0].post.text], flops: [] };
  }

  const k = Math.min(3, Math.floor(n / 2));

  const topPatterns = sorted.slice(0, k).map((x) => x.post.text);
  const flops = sorted
    .slice(n - k)
    .reverse()
    .map((x) => x.post.text);

  return { topPatterns, flops };
}
