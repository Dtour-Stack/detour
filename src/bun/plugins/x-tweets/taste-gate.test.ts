import { describe, expect, test } from "bun:test";
import { parseTasteVerdict, passesTaste } from "./taste-gate";

describe("taste gate", () => {
  test("parses a TOON verdict", () => {
    const v = parseTasteVerdict("score: 8\nharm: false\nreason: specific and funny");
    expect(v.score).toBe(8);
    expect(v.harm).toBe(false);
  });
  test("blocks below threshold", () => {
    expect(passesTaste({ score: 5, harm: false, reason: "" }, 7)).toBe(false);
  });
  test("blocks any harm flag regardless of score", () => {
    expect(passesTaste({ score: 10, harm: true, reason: "tragedy bait" }, 7)).toBe(false);
  });
  test("passes a strong, safe draft", () => {
    expect(passesTaste({ score: 8, harm: false, reason: "" }, 7)).toBe(true);
  });
  test("fails closed on an unparseable verdict", () => {
    const v = parseTasteVerdict("garbage");
    expect(passesTaste(v, 7)).toBe(false);
  });
});
