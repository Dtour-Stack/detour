/** Radar digest builder.
 *
 * Pure leaf formatter: no imports from Detour modules, no process.env,
 * no I/O, no Date.now(). Takes all context as parameters so tests stay
 * deterministic.
 *
 * ASCII punctuation only -- no em dashes or en dashes anywhere.
 */

export interface RadarItem {
  title: string;
  snippet?: string;
  url?: string;
  source?: string;
}

/** Normalize a title for dedup comparison: lowercase, trim, collapse runs of
 * whitespace to a single space. */
function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Truncate a string to at most maxLen characters. */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + "...";
}

/** Build a compact "what is happening now" digest from web-search results and X
 *  trend strings. Dedup by normalized title, cap to opts.maxItems (default 8),
 *  prefix each item line with "- ", include the dateLabel as a header.
 *  Returns "" when there is nothing to show. */
export function buildRadarDigest(
  items: RadarItem[],
  trends: string[],
  opts?: { maxItems?: number; dateLabel?: string },
): string {
  const maxItems = opts?.maxItems ?? 8;
  const dateLabel = opts?.dateLabel;

  // Dedup items by normalized title, keep first occurrence.
  const seen = new Set<string>();
  const deduped: RadarItem[] = [];
  for (const item of items) {
    const key = normalizeTitle(item.title);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(item);
    }
  }

  // Cap to maxItems.
  const capped = deduped.slice(0, maxItems);

  // Cap trends too so total output stays bounded.
  const trendsCapped = trends.slice(0, 10);

  if (capped.length === 0 && trendsCapped.length === 0) return "";

  const lines: string[] = [];

  if (dateLabel) {
    lines.push(dateLabel);
  }

  for (const item of capped) {
    // Bound each field to keep per-line contribution predictable.
    const title = truncate(item.title.trim(), 120);
    const parts: string[] = [title];
    if (item.snippet) {
      parts.push(truncate(item.snippet.trim(), 100));
    }
    if (item.source) {
      parts.push(`[${truncate(item.source.trim(), 40)}]`);
    }
    lines.push("- " + parts.join(" | "));
  }

  if (trendsCapped.length > 0) {
    lines.push("Trending: " + trendsCapped.map((t) => truncate(t.trim(), 30)).join(", "));
  }

  return lines.join("\n");
}

/** Extract the item headlines (titles) from a digest built by buildRadarDigest, so a
 *  caller can use ONE concise topic as a search query instead of the whole multi-line
 *  digest. Skips the date header and the "Trending:" line. Returns [] when there are
 *  no item lines. */
export function topicsFromRadarDigest(digest: string): string[] {
  const out: string[] = [];
  for (const raw of digest.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("- ")) continue;
    const title = line.slice(2).split(" | ")[0]?.trim() ?? "";
    if (title) out.push(title);
  }
  return out;
}
