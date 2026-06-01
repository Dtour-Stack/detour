---
name: project_x_tweets_phase2_topology
description: X-tweets Phase 2 (persona/detour-squirrel-v2) topology baseline — lane ownership, cycle ratchet, flow-gate result, and invariants verified at commit 81f148fb
metadata:
  type: project
---

Phase 2 x-tweets persona lane (commits 1c773a0f..81f148fb on branch persona/detour-squirrel-v2) passed Flow Gate POST-FLIGHT on 2026-05-29.

**Cycle ratchet:** 67 (all in eliza submodule or pre-existing core cycles -- none introduced by Phase 2).
**check:flow violations:** 0.
**typecheck:** clean.

**Lane:**
```
src/bun/core/index.ts (boot)
  -> src/bun/core/x-{radar,style,feedback}-service.ts  (setInterval orchestration, Pensieve writes)
  -> src/bun/plugins/x-tweets/{radar,style-mining,feedback}.ts  (pure leaf formatters, no Detour imports)
  -> ~/.detour/x-{radar-latest.txt,style-psyche.md,x-feedback-lessons.md}  (file-contract)
  <- src/bun/plugins/x-tweets/index.ts  (reads back via readFileSync, no core import)
```

**Invariants verified:**
- Pure leaves (radar.ts, style-mining.ts, feedback.ts): zero imports from src/bun or src/shared.
- Core services import only: @elizaos/core, ../plugins/x-tweets/{leaf}, ./pensieve/memory-service, node builtins.
- x-tweets/index.ts: no import from src/bun/core (file-contract is the only coupling).
- x-feedback-service.ts: owns ~/.detour/x-feedback-lessons.md exclusively; does NOT touch trajectory-lessons.md.
- No core/index barrel re-export of the three new services.
- Taste gate (scoreDraft + passesTaste) wraps BOTH the primary and fallback paths in processXStatusPost (lines 2074 and 2099).
- Taste gate wraps the autonomous notification reply path (line 1045) and discovery reply path (line 1613).
- No unconditional PROJECT_DEFENSE or CA shill injection; token answers are gated or owner-commanded only.
- Settings registered in src/shared/settings-registry.ts: X_RADAR_INTERVAL_MS, X_STYLE_INTERVAL_MS, X_FEEDBACK_INTERVAL_MS, X_STYLE_EXEMPLARS.
- Skeleton.tsx UI commit (c1060047) is fully isolated to src/main -- no cross-layer imports.

**Why:** Phase 2 plan contract requires core services to own orchestration so x-tweets stays import-clean; file-contract decouples the read-back direction without creating a circular or upward dependency.
**How to apply:** If future x-tweets work needs access to radar/style/feedback data, it must read the file-contract (~/.detour/x-*.{txt,md}) -- never import from core services directly.
