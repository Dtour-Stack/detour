import { describe, expect, test } from "bun:test";
import { summarizeEngagement, type PostEngagement } from "./feedback";

describe("summarizeEngagement", () => {
  test("returns empty arrays for empty input", () => {
    const result = summarizeEngagement([]);
    expect(result.topPatterns).toEqual([]);
    expect(result.flops).toEqual([]);
  });

  test("single post goes to topPatterns, not flops", () => {
    const posts: PostEngagement[] = [
      { text: "solo post", replyCount: 1, retweetCount: 0, favoriteCount: 0 },
    ];
    const result = summarizeEngagement(posts);
    expect(result.topPatterns).toContain("solo post");
    expect(result.flops).toHaveLength(0);
  });

  test("a post with many replies outranks one with many likes only", () => {
    // replies*3 = 10*3 = 30 vs likes*0.5 = 100*0.5 = 50 -- so this is a borderline test
    // Use clear separation: replies post score = 30*3 = 90, likes-only = 5*0.5 = 2.5
    const posts: PostEngagement[] = [
      { text: "reply winner", replyCount: 30, retweetCount: 0, favoriteCount: 0 },
      { text: "likes only loser", replyCount: 0, retweetCount: 0, favoriteCount: 5 },
    ];
    const result = summarizeEngagement(posts);
    expect(result.topPatterns[0]).toBe("reply winner");
  });

  test("reposts weighted above likes", () => {
    // reposts*2 = 20*2 = 40 vs likes*0.5 = 100*0.5 = 50 -- borderline, use clear numbers
    // reposts*2 = 50*2 = 100 vs likes*0.5 = 10*0.5 = 5
    const posts: PostEngagement[] = [
      { text: "repost winner", replyCount: 0, retweetCount: 50, favoriteCount: 0 },
      { text: "likes only", replyCount: 0, retweetCount: 0, favoriteCount: 10 },
    ];
    const result = summarizeEngagement(posts);
    expect(result.topPatterns[0]).toBe("repost winner");
  });

  test("exact score formula: replies*3 + reposts*2 + likes*0.5", () => {
    // post A: 1*3 + 1*2 + 2*0.5 = 3+2+1 = 6
    // post B: 0*3 + 0*2 + 20*0.5 = 10
    // post B should rank higher
    const posts: PostEngagement[] = [
      { text: "mixed small", replyCount: 1, retweetCount: 1, favoriteCount: 2 },
      { text: "likes heavy", replyCount: 0, retweetCount: 0, favoriteCount: 20 },
    ];
    const result = summarizeEngagement(posts);
    expect(result.topPatterns[0]).toBe("likes heavy");
  });

  test("topPatterns and flops have no overlap", () => {
    const posts: PostEngagement[] = [
      { text: "post A", replyCount: 10, retweetCount: 5, favoriteCount: 100 },
      { text: "post B", replyCount: 0, retweetCount: 0, favoriteCount: 1 },
      { text: "post C", replyCount: 5, retweetCount: 2, favoriteCount: 50 },
      { text: "post D", replyCount: 0, retweetCount: 1, favoriteCount: 0 },
      { text: "post E", replyCount: 8, retweetCount: 3, favoriteCount: 20 },
    ];
    const result = summarizeEngagement(posts);
    const topSet = new Set(result.topPatterns);
    for (const flop of result.flops) {
      expect(topSet.has(flop)).toBe(false);
    }
  });

  test("populates topPatterns and flops for a mixed set", () => {
    const posts: PostEngagement[] = [
      { text: "viral post", replyCount: 50, retweetCount: 20, favoriteCount: 500 },
      { text: "medium post", replyCount: 5, retweetCount: 2, favoriteCount: 30 },
      { text: "dead post", replyCount: 0, retweetCount: 0, favoriteCount: 1 },
    ];
    const result = summarizeEngagement(posts);
    expect(result.topPatterns.length).toBeGreaterThan(0);
    expect(result.flops.length).toBeGreaterThan(0);
    expect(result.topPatterns[0]).toBe("viral post");
  });

  test("two posts: top gets winner, flops gets loser", () => {
    const posts: PostEngagement[] = [
      { text: "winner", replyCount: 10, retweetCount: 5, favoriteCount: 20 },
      { text: "loser", replyCount: 0, retweetCount: 0, favoriteCount: 0 },
    ];
    const result = summarizeEngagement(posts);
    expect(result.topPatterns).toContain("winner");
    expect(result.flops).toContain("loser");
  });

  test("returns text strings (not score objects)", () => {
    const posts: PostEngagement[] = [
      { text: "a post", replyCount: 1, retweetCount: 0, favoriteCount: 0 },
    ];
    const result = summarizeEngagement(posts);
    for (const p of result.topPatterns) {
      expect(typeof p).toBe("string");
    }
  });
});
