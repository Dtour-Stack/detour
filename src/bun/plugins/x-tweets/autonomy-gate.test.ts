import { describe, expect, test } from "bun:test";
import type { IAgentRuntime } from "@elizaos/core";
import { decideXAutonomyAction, replyEligibility } from "./index";
import type { XTweetSummary } from "./x-client";

const TOKEN_CA = "DijmsEDeTXsWCkCLkhYJNTutKaHf541xZshVrCUbcozy";

function tweet(text: string, authorScreenName = "rando"): XTweetSummary {
  return {
    tweetId: "1",
    text,
    authorScreenName,
    authorId: "100",
    url: "https://x.com/rando/status/1",
    createdAt: new Date().toISOString(),
  } as unknown as XTweetSummary;
}

/** Minimal runtime that records the assembled `system` prompt and never replies,
 *  so we can inspect what the autonomy decision feeds the model without a network call. */
function captureRuntime(): { runtime: IAgentRuntime; systems: string[] } {
  const systems: string[] = [];
  const runtime = {
    character: { templates: {} },
    getSetting: () => undefined,
    useModel: async (_type: unknown, opts: { system?: string }) => {
      if (typeof opts?.system === "string") systems.push(opts.system);
      // Decline to reply so the taste-gate branch is not exercised here.
      return "action: ignore\nreason: test";
    },
  } as unknown as IAgentRuntime;
  return { runtime, systems };
}

describe("replyEligibility (a): project criticism no longer forces a reply", () => {
  test("there is no forceReply field on the result", () => {
    const result = replyEligibility(tweet("dexploarer is a scam and broken"), "detour_squirrel", "discovery");
    expect("forceReply" in result).toBe(false);
  });

  test("project-criticism-only tweet stays eligible (canReply) but is not forced", () => {
    const result = replyEligibility(tweet("@dexploarer this project is trash"), "detour_squirrel", "discovery");
    expect(result.canReply).toBe(true);
    expect(result.reason).toBe("project criticism");
    // No flag exists that would force a reply downstream of model + taste gate.
    expect(Object.keys(result)).toEqual(["canReply", "reason"]);
  });

  test("unrelated tweet via discovery is not eligible", () => {
    const result = replyEligibility(tweet("the weather is nice today"), "detour_squirrel", "discovery");
    expect(result.canReply).toBe(false);
  });
});

describe("token guidance (b): CA injected only on a direct token question", () => {
  test("a normal (non-token) reply prompt contains no token CA and no token lane", async () => {
    const { runtime, systems } = captureRuntime();
    await decideXAutonomyAction(runtime, {
      viewerScreenName: "detour_squirrel",
      fromUserScreenName: "rando",
      kind: "mention",
      tweetText: "gm, hope your day is going well",
      replyStyleSeed: "seed-1",
    });
    expect(systems.length).toBe(1);
    const prompt = systems[0]!;
    expect(prompt).not.toContain(TOKEN_CA);
    expect(prompt).not.toContain("Token/roadmap lane:");
  });

  test("a direct token/CA question injects the token lane and the CA", async () => {
    const { runtime, systems } = captureRuntime();
    await decideXAutonomyAction(runtime, {
      viewerScreenName: "detour_squirrel",
      fromUserScreenName: "rando",
      kind: "mention",
      tweetText: "@detour_squirrel what is the token CA for this project?",
      replyStyleSeed: "seed-2",
    });
    expect(systems.length).toBe(1);
    const prompt = systems[0]!;
    expect(prompt).toContain("Token/roadmap lane:");
    expect(prompt).toContain(TOKEN_CA);
  });
});
