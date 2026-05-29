import { describe, expect, test } from "bun:test";
import { distillPsychePrompt, formatPsyche, type AccountSamples } from "./style-mining";

describe("distillPsychePrompt", () => {
  test("includes each handle in the prompt", () => {
    const samples: AccountSamples[] = [
      { handle: "@alpha", tweets: ["tweet a1", "tweet a2"] },
      { handle: "@beta", tweets: ["tweet b1"] },
    ];
    const prompt = distillPsychePrompt(samples);
    expect(prompt).toContain("@alpha");
    expect(prompt).toContain("@beta");
  });

  test("includes the tweet text samples in the prompt", () => {
    const samples: AccountSamples[] = [{ handle: "@alpha", tweets: ["specific tweet content here"] }];
    const prompt = distillPsychePrompt(samples);
    expect(prompt).toContain("specific tweet content here");
  });

  test("includes instruction about patterns not verbatim lines", () => {
    const samples: AccountSamples[] = [{ handle: "@alpha", tweets: ["something"] }];
    const prompt = distillPsychePrompt(samples);
    const lower = prompt.toLowerCase();
    // Must instruct to extract patterns only, never verbatim
    const hasPatternInstruction = lower.includes("pattern") || lower.includes("craft");
    expect(hasPatternInstruction).toBe(true);
    const hasNoVerbatimInstruction =
      lower.includes("verbatim") ||
      lower.includes("never copy") ||
      lower.includes("do not copy") ||
      lower.includes("not reproduce");
    expect(hasNoVerbatimInstruction).toBe(true);
  });

  test("includes instruction to not copy identity or handle", () => {
    const samples: AccountSamples[] = [{ handle: "@alpha", tweets: ["something"] }];
    const prompt = distillPsychePrompt(samples);
    const lower = prompt.toLowerCase();
    const hasIdentityInstruction =
      lower.includes("identity") ||
      lower.includes("handle") ||
      lower.includes("persona");
    expect(hasIdentityInstruction).toBe(true);
  });

  test("handles empty samples array", () => {
    const prompt = distillPsychePrompt([]);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("handles account with no tweets", () => {
    const samples: AccountSamples[] = [{ handle: "@empty", tweets: [] }];
    const prompt = distillPsychePrompt(samples);
    expect(prompt).toContain("@empty");
  });

  test("includes multiple accounts' tweets", () => {
    const samples: AccountSamples[] = [
      { handle: "@one", tweets: ["tweet one A", "tweet one B"] },
      { handle: "@two", tweets: ["tweet two A"] },
    ];
    const prompt = distillPsychePrompt(samples);
    expect(prompt).toContain("tweet one A");
    expect(prompt).toContain("tweet one B");
    expect(prompt).toContain("tweet two A");
  });
});

describe("formatPsyche", () => {
  test("trims whitespace", () => {
    const result = formatPsyche("  some text  ");
    expect(result).toBe("some text");
  });

  test("caps length at approximately 1200 chars", () => {
    const longText = "A".repeat(2000);
    const result = formatPsyche(longText);
    expect(result.length).toBeLessThanOrEqual(1200);
  });

  test("preserves content under the cap", () => {
    const short = "Short psyche content";
    expect(formatPsyche(short)).toBe(short);
  });

  test("handles empty string", () => {
    expect(formatPsyche("")).toBe("");
  });

  test("does not mangle content within bounds", () => {
    const text = "opener: short punchy statement. tone: dry wit. structure: one idea per tweet.";
    expect(formatPsyche(text)).toBe(text);
  });
});
