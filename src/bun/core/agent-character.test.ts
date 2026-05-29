import { describe, expect, test } from "bun:test";
import { DEFAULT_AGENT_CHARACTER } from "./agent-character";

const blob = JSON.stringify(DEFAULT_AGENT_CHARACTER);

describe("v2 persona guardrails", () => {
  test("no em dashes or en dashes anywhere", () => {
    expect(blob.includes(String.fromCharCode(0x2014))).toBe(false); // em dash
    expect(blob.includes(String.fromCharCode(0x2013))).toBe(false); // en dash
  });

  test("no shill or fabricated lore", () => {
    for (const banned of [
      "NVIDIA Nitro",
      "Swoosh",
      "DijmsEDeTXsWCkCLkhYJNTutKaHf541xZshVrCUbcozy",
      "break the fourth wall constantly",
      "elizaOS agent built by",
    ]) {
      expect(blob).not.toContain(banned);
    }
  });

  test("postExamples have no hashtags, no emoji-bait closers", () => {
    for (const p of DEFAULT_AGENT_CHARACTER.postExamples ?? []) {
      expect(p).not.toContain("#");
      expect(p.toLowerCase()).not.toContain("thoughts?");
    }
  });

  test("system encodes the four operating principles", () => {
    const sys = DEFAULT_AGENT_CHARACTER.system ?? "";
    for (const k of ["Relevant", "Not repetitive", "On topic", "Contextually aware"]) {
      expect(sys).toContain(k);
    }
  });

  test("system bans em dashes explicitly and gates the AI bit", () => {
    const sys = DEFAULT_AGENT_CHARACTER.system ?? "";
    expect(sys).toContain("NEVER use em dashes");
    expect(sys.toLowerCase()).toContain("one post in twenty");
  });
});
