import { describe, expect, test } from "bun:test";
import { X_SQUIRREL_VOICE, X_ALGORITHM_PLAYBOOK } from "./index";

describe("X voice guardrails", () => {
  const voice = X_SQUIRREL_VOICE.join("\n");
  test("no em dashes", () => {
    expect(voice.includes(String.fromCharCode(0x2014))).toBe(false); // em dash
  });
  test("no token CA, no gaming lore, no shill defaults", () => {
    for (const banned of ["DijmsEDeTXsWCkCLkhYJNTutKaHf541xZshVrCUbcozy", "NVIDIA Nitro", "Swoosh", "Hype elizaOS"]) {
      expect(voice).not.toContain(banned);
    }
  });
  test("voice carries the four-rule spine and the no-em-dash ban", () => {
    expect(voice).toContain("NEVER use em dashes");
    expect(voice.toLowerCase()).toContain("conversation");
  });
  test("playbook is world-commentary framed, not product-defense framed", () => {
    const pb = X_ALGORITHM_PLAYBOOK.join("\n");
    expect(pb).not.toContain("Criticism of Dexploarer");
  });
});
