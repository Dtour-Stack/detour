/** Style psyche builder and formatter.
 *
 * Pure leaf formatter: no imports from Detour modules, no process.env,
 * no I/O, no side effects. Takes all context as parameters so tests stay
 * deterministic.
 *
 * ASCII punctuation only -- no em dashes or en dashes anywhere.
 */

export interface AccountSamples {
  handle: string;
  tweets: string[];
}

/** Build the LLM prompt that distills REUSABLE CRAFT from exemplar tweets.
 *
 * The prompt instructs the model to extract patterns only -- never verbatim
 * lines and never another account's identity or handle. The resulting psyche
 * text can be safely injected into a system prompt via formatPsyche(). */
export function distillPsychePrompt(samples: AccountSamples[]): string {
  const lines: string[] = [
    "You are a craft analyst. Your task is to extract REUSABLE writing patterns from",
    "the tweet samples below.",
    "",
    "Rules:",
    "- Extract patterns only (typical length, structure, opener variety, humor type,",
    "  rhythm, what makes the post land).",
    "- Never reproduce any verbatim line from the samples.",
    "- Never copy or impersonate any account's identity, persona, or handle.",
    "- Do not mention any account handle in your output.",
    "- Output a short psyche summary (under 1000 chars) the writer can use as a style",
    "  guide without becoming another account.",
    "",
  ];

  if (samples.length === 0) {
    lines.push("(No sample accounts provided. Return a generic craft summary.)");
    return lines.join("\n");
  }

  for (const account of samples) {
    lines.push(`Account: ${account.handle}`);
    if (account.tweets.length === 0) {
      lines.push("(no sample tweets)");
    } else {
      for (const tweet of account.tweets) {
        lines.push(`  sample: ${tweet}`);
      }
    }
    lines.push("");
  }

  lines.push(
    "Distill the shared craft patterns across these accounts into a concise psyche",
    "summary. Focus on structure, voice, and what makes each post resonate -- not on",
    "the specific accounts or their identities.",
  );

  return lines.join("\n");
}

/** Bound and sanitize the model's distilled psyche text for safe injection into
 *  a system prompt: trim whitespace and cap to ~1200 chars. */
export function formatPsyche(modelOutput: string): string {
  const trimmed = modelOutput.trim();
  if (trimmed.length <= 1200) return trimmed;
  return trimmed.slice(0, 1200);
}
