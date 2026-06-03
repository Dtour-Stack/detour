---
type: roadmap
title: Agent Workspaces — Enhancement Roadmap
tags: [roadmap, agent-workspaces, automation]
created: 2026-06-03
---

# 🧭 Agent Workspaces — Enhancement Roadmap

> What's left to make this **self-improving** (not just self-documenting), **proactive** (not pull-only), and **smart end-to-end** — without breaking the safety design.

## The one principle to hold onto

Every README in this system says it: *"never auto-installs," "review-gated on purpose," "promotion is always manual."* Those manual gates are **deliberate safety architecture**, not friction to remove. A bad skill auto-installed into `~/.claude/skills/` would fire in *every* future session.

So the goal of "smart everything" is **not** "let the AI install its own skills." It is:

> **Make the gated decision trivial and well-informed** — so when you approve, it's one tap on a recommendation the system already did the thinking for.

That reframe runs through every theme below.

## What's already excellent (don't touch)

- ✅ **Capture is complete & lossless** — 2,014 sessions; Codex verified at 64/64 on disk (incl. archived). No data loss.
- ✅ **$0 deterministic mining** + incremental state. Re-runs in ~0.1s.
- ✅ **4-axis taxonomy**, orphan-prune, secret-safe HF export, JSONL viewer.
- ✅ **Live wiring**: SessionEnd hook + 3h launchd timer (status 0 = healthy).
- ✅ **Synthesis works** — the `orchestrate` skill it produced is genuinely good.

The pipeline today: **Capture (auto) → Mine (auto) → Synthesize (manual) → Review (manual) → Promote (manual).**
The gap: it's an **open loop** — nothing measures whether a promoted skill actually *helped*, and nothing *pushes* anything to you.

---

## Theme 1 — Data quality: dedup the candidate pool  ⭐ build first
**Status:** 519 candidates, heavily redundant (the Insights table is choked with near-identical milady/swoosh CI failures). Real distinct patterns ≈ 50.
**Fix:** a deterministic clustering pass — group candidates by `(error-signature hash × topic set)`, keep the highest-scoring exemplar per cluster, store `cluster_size` as a signal. $0, no LLM.
**Payoff:** sharper Insights, cheaper synthesis, and a digest that isn't noise. **Everything downstream depends on this.**
**Smart version:** `cluster_size` becomes a frequency score — "this exact failure hit you 14× across 5 projects" is the strongest possible promote signal.

## Theme 2 — Close the loop: efficacy measurement  ⭐ the headline
**Status:** Nothing measures whether a promoted skill *reduced recurrence* of the error it targets. `skills_inspect.py` counts *uses*, not *outcomes*. → today this is **self-documenting, not self-improving.**
**Fix:** tag each promoted skill with the error-signature(s) it addresses (uses Theme 1's signatures). After promotion, track that signature's recurrence rate in newly-captured sessions. Surface: *"`debugging-dependency-installs`: recurrence ↓80% since promote"* or *"`freeing-disk-space-safely`: no change in 3 weeks — revise or retire."*
**Payoff:** this is the feedback edge that makes it a **loop**. It's the single thing that earns the phrase "self-improving."
**Depends on:** Theme 1 (needs stable signatures first).

## Theme 3 — Proactive surface: the digest  ⭐ biggest day-to-day win
**Status:** 100% pull. You must remember to open `Insights.md` / `_synthesis-inbox/`. Nothing reaches you. (This is the direct ADHD-fit gap.)
**Fix:** a scheduled digest (reuse the launchd timer) → a vault **daily note** + **Telegram** (the `telegram` plugin is already connected). Format:
> *"This week: 47 new sessions · top recurring pain = `git-ci` test flakiness (5 projects) · 3 drafts ready. My pick: promote `debugging-e2e-test-harness`. Approve? y/n"*
**Payoff:** turns the manual review gate into a one-tap decision. Honors the safety design **and** "keep my directions straight."
**Smart version:** approve-by-reply — `y` triggers `promote_skill.py` for the recommended draft. The gate stays; the effort goes to zero.

## Theme 4 — Route knowledge home  (cheap, currently orphaned)
**Status:** Mined `## Learnings` dead-end in `_synthesis-inbox/` — nothing routes them to `.remember/`. The MOC links `.remember/session-learnings.md`, which isn't the file the memory system actually maintains. And there's **no path to propose `CLAUDE.md` / `AGENTS.md` rule additions** from recurring patterns.
**Fix:** (a) wire mined standing memories → `.remember/` (review-gated, append-with-dedup). (b) add a "proposed standing rule" output: when a pattern recurs across 3+ projects, draft a one-line CLAUDE.md rule for approval.
**Payoff:** this is where learning actually **changes future behavior** — skills are on-demand; standing memory & CLAUDE.md rules are always-on.

## Theme 5 — Self-monitoring & hygiene  (make it run itself)
**Status:** No health surface — if the hook silently breaks, nothing tells you. `skills_inspect.py` flags 14 unused + 1 overlap pair but never acts.
**Fix:** (a) a **health dashboard note** (Dataview: last run, candidate growth rate, synthesis backlog, promotion count; **alert if sync is stale > 12h**). (b) scheduled **reversible** auto-quarantine of long-unused *standalone* skills — with a digest line, never silent (`--quarantine` infra already exists).
**Payoff:** the system watches itself and tells you when it needs attention, instead of you discovering rot.

---

## Sidebar — synthesis quality (optimization, not a fix)
The current `claude -p` synthesis already produced a good skill, so it's **not broken.** Two upgrades when you get to it:
1. **Dedup vs. existing skills** — the synthesis prompt doesn't include the 112 installed skill descriptions, so it can regenerate something that already exists. Feed it the catalog → "propose an *edit* to `X`" instead of a new draft. (This is the one real *correctness* gap in synthesis.)
2. **Synthesis-as-Workflow** — cluster → draft → adversarially verify → dedup, using the `orchestrate` pattern you already drafted. Sharper drafts, still review-gated.

## Recommended sequence
```
Theme 1 (dedup)  ──>  Theme 2 (efficacy)  ──>  Theme 3 (digest)
   data quality        the self-improving        proactive
   (foundation)          loop (headline)          (daily win)
        │
        └──>  Theme 4 (route home) + Theme 5 (self-monitor)  [parallel, anytime]
```
**Start with Theme 1** — it's $0, foundational, and the redundancy is the most visible problem in `Insights.md` today. Then Theme 2 closes the loop, Theme 3 makes it a daily companion.

> Nothing here removes a human gate. Every theme makes the gated decision **smaller, better-informed, and one-tap.**
