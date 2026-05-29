import type { IAgentRuntime } from "@elizaos/core";
import { ModelType, logger } from "@elizaos/core";

export type TasteVerdict = { score: number; harm: boolean; reason: string };

const TASTE_RUBRIC = [
  "You are the editor for an X account. Score a DRAFT post before it goes out.",
  "Rate 0 to 10 on: relevant to the moment, specific and non-obvious, funny or genuinely useful, and likely to start a conversation.",
  "Set harm: true if the draft punches down at a person, riffs on a tragedy or live disaster, is outrage or engagement bait, is off-topic spam, reveals private info, or is the kind of thing that earns a mute, block, or report. When unsure, harm: true.",
  "Output TOON only:",
  "score: <0-10>",
  "harm: <true|false>",
  "reason: <one short line>",
].join("\n");

/** Parse the model's TOON verdict. Fails closed: unparseable => score 0, harm true. */
export function parseTasteVerdict(text: string): TasteVerdict {
  const scoreM = text.match(/score:\s*(\d{1,2})/i);
  const harmM = text.match(/harm:\s*(true|false)/i);
  if (!scoreM || !harmM) return { score: 0, harm: true, reason: "unparseable verdict" };
  const reasonM = text.match(/reason:\s*(.+)/i);
  return {
    score: Math.max(0, Math.min(10, Number.parseInt(scoreM[1], 10))),
    harm: harmM[1].toLowerCase() === "true",
    reason: reasonM?.[1]?.trim() ?? "",
  };
}

export function passesTaste(v: TasteVerdict, threshold: number): boolean {
  return !v.harm && v.score >= threshold;
}

/** Score a draft via the model. Fails CLOSED (returns a blocking verdict) on any error. */
export async function scoreDraft(runtime: IAgentRuntime, draft: string, context: string): Promise<TasteVerdict> {
  try {
    const out = await runtime.useModel(ModelType.TEXT_SMALL, {
      system: TASTE_RUBRIC,
      prompt: `DRAFT:\n${draft}\n\nCONTEXT:\n${context || "(none)"}\n\nScore it in TOON.`,
    });
    return parseTasteVerdict(typeof out === "string" ? out : String(out ?? ""));
  } catch (err) {
    logger.warn({ src: "x-tweets:taste", err: err instanceof Error ? err.message : err }, "taste gate scoring failed, blocking");
    return { score: 0, harm: true, reason: "scoring error" };
  }
}

export const TASTE_THRESHOLD = 7;
