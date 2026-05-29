import { describe, expect, test } from "bun:test";
import { buildRadarDigest, type RadarItem } from "./radar";

describe("buildRadarDigest", () => {
  test("returns empty string for no items and no trends", () => {
    expect(buildRadarDigest([], [])).toBe("");
  });

  test("returns empty string for empty arrays with opts", () => {
    expect(buildRadarDigest([], [], { maxItems: 5, dateLabel: "Mon" })).toBe("");
  });

  test("includes dateLabel as header when provided", () => {
    const items: RadarItem[] = [{ title: "Some news" }];
    const result = buildRadarDigest(items, [], { dateLabel: "Mon May 26" });
    expect(result).toContain("Mon May 26");
  });

  test("includes trend strings in output", () => {
    const trends = ["#AINews", "#Crypto"];
    const result = buildRadarDigest([], trends, { dateLabel: "Today" });
    expect(result).toContain("#AINews");
    expect(result).toContain("#Crypto");
  });

  test("deduplicates items by normalized title (case-insensitive)", () => {
    const items: RadarItem[] = [
      { title: "Big Story" },
      { title: "big story" },
      { title: "  BIG STORY  " },
    ];
    const result = buildRadarDigest(items, []);
    // Only one instance of the story should appear
    const matches = result.split("Big Story").length - 1 + result.split("big story").length - 1;
    // Count occurrences of any case variant of the title line
    const lines = result.split("\n").filter((l) => l.toLowerCase().includes("big story"));
    expect(lines.length).toBe(1);
  });

  test("deduplicates whitespace-variant titles", () => {
    const items: RadarItem[] = [
      { title: "Market crash" },
      { title: "market  crash" },
    ];
    const result = buildRadarDigest(items, []);
    const lines = result.split("\n").filter((l) => l.toLowerCase().includes("market"));
    expect(lines.length).toBe(1);
  });

  test("caps at maxItems (default 8)", () => {
    const items: RadarItem[] = Array.from({ length: 15 }, (_, i) => ({ title: `Story ${i}` }));
    const result = buildRadarDigest(items, []);
    const bulletLines = result.split("\n").filter((l) => l.startsWith("- "));
    expect(bulletLines.length).toBeLessThanOrEqual(8);
  });

  test("caps at explicit maxItems", () => {
    const items: RadarItem[] = Array.from({ length: 10 }, (_, i) => ({ title: `Story ${i}` }));
    const result = buildRadarDigest(items, [], { maxItems: 3 });
    const bulletLines = result.split("\n").filter((l) => l.startsWith("- "));
    expect(bulletLines.length).toBeLessThanOrEqual(3);
  });

  test("prefixes each item with a bullet", () => {
    const items: RadarItem[] = [{ title: "Alpha" }, { title: "Beta" }];
    const result = buildRadarDigest(items, []);
    const bulletLines = result.split("\n").filter((l) => l.startsWith("- "));
    expect(bulletLines.length).toBeGreaterThanOrEqual(2);
  });

  test("output is bounded under 2000 chars for large input", () => {
    const longTitle = "A".repeat(500);
    const longSnippet = "B".repeat(500);
    const items: RadarItem[] = Array.from({ length: 20 }, () => ({
      title: longTitle,
      snippet: longSnippet,
      url: "https://example.com/very-long-url-here",
      source: "SomeSource",
    }));
    const trends = Array.from({ length: 20 }, (_, i) => `#Trend${i}`);
    const result = buildRadarDigest(items, trends, { dateLabel: "Today" });
    expect(result.length).toBeLessThan(2000);
  });

  test("includes snippet when provided", () => {
    const items: RadarItem[] = [{ title: "Alpha", snippet: "Some detail here" }];
    const result = buildRadarDigest(items, []);
    expect(result).toContain("Some detail here");
  });

  test("works with trends only (no items)", () => {
    const result = buildRadarDigest([], ["#Hot"], { dateLabel: "Fri" });
    expect(result).toContain("#Hot");
    expect(result.length).toBeGreaterThan(0);
  });
});
