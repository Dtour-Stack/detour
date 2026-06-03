# Codex — Captured Memories & Context

_Sanitized copies of `~/.codex/memories/*.md` (read-only source)._

## MEMORY.md

# Task Group: Detour Cloud coding shell, design workspace QA, and open-beta admin follow-through
scope: Use this block for June 1 Detour Cloud work when the task is changing the coding shell, checking whether a cloud/signup lane is actually ready, tightening the design workspace, or manually QAing login/admin/profile surfaces without confusing browser context for repo truth.
applies_to: cwd=browser/chronicle context and visible dtour-cloud worktrees; reuse_rule=safe to reuse for Detour Cloud workflow routing, but treat deploy state, localhost ports, admin data, and social/posting context as time-specific until rechecked in the repo or dashboard.
## Task 1: Move coding views into the main side navigation and preserve shared session state, partial
### rollout_summary_files
- extensions/chronicle/resources/2026-06-01T09-27-00-tlfT-10min-memory-summary.md (cwd=browser/chronicle context, rollout_path=extensions/chronicle/resources/2026-06-01T09-27-00-tlfT-10min-memory-summary.md, updated_at=2026-06-01T09:27:00+00:00, thread_id=None, `CODING_NAV` shell refactor, route mapping, and shared coding session state) [chronicle memory]
- extensions/chronicle/resources/2026-06-01T09-29-00-lqmp-10min-memory-summary.md (cwd=browser/chronicle context, rollout_path=extensions/chronicle/resources/2026-06-01T09-29-00-lqmp-10min-memory-summary.md, updated_at=2026-06-01T09:29:00+00:00, thread_id=None, Codex setup page, agent list, API-key screen, and coding-shell parity check) [chronicle memory]
### keywords
- dtour-cloud, CODING_NAV, CodingSessionContext, /coding, /coding/setup, /coding/draft, /coding/saves, /coding/opencode, /codex, /claude, /pi, /openrouter, Open terminal · codex, Save encrypted key, bun-types, _ignoreDeprecations
## Task 2: Separate mock E2E success from live readiness and smoke-lane truth, partial
### rollout_summary_files
- extensions/chronicle/resources/2026-06-01T09-37-00-fQBb-10min-memory-summary.md (cwd=browser/chronicle context, rollout_path=extensions/chronicle/resources/2026-06-01T09-37-00-fQBb-10min-memory-summary.md, updated_at=2026-06-01T09:37:00+00:00, thread_id=None, passing mock-backed cloud E2E plus separate `test:cloud` and smoke-lane troubleshooting) [chronicle memory]
- extensions/chronicle/resources/2026-06-01T14-39-00-KQzG-10min-memory-summary.md (cwd=browser/chronicle context, rollout_path=extensions/chronicle/resources/2026-06-01T14-39-00-KQzG-10min-memory-summary.md, updated_at=2026-06-01T14:39:00+00:00, thread_id=None, readiness/status question, review-recent-updates thread, and CI follow-through context) [chronicle memory]
- extensions/chronicle/resources/2026-06-01T14-49-00-NqBU-10min-memory-summary.md (cwd=browser/chronicle context, rollout_path=extensions/chronicle/resources/2026-06-01T14-49-00-NqBU-10min-memory-summary.md, updated_at=2026-06-01T14:49:00+00:00, thread_id=None, cloud-signup answer, PR/check review, and local Playwright wrapper note) [chronicle memory]
### keywords
- developer/tester signups, admin agent, AgentMail env vars, inference env vars, Discord gateway fixture test, exact secret grep, test:cloud, mock cloud e2e, ECONNREFUSED, credits balance, proxy calls, Playwright, live-stack
## Task 3: Tighten design workspace structure and manually inspect login, requests, flags, and profile flows, partial
### rollout_summary_files
- extensions/chronicle/resources/2026-06-01T16-15-00-ciIc-10min-memory-summary.md (cwd=browser/chronicle context, rollout_path=extensions/chronicle/resources/2026-06-01T16-15-00-ciIc-10min-memory-summary.md, updated_at=2026-06-01T16:15:00+00:00, thread_id=None, design workspace QA on `/design/canvas`, `/design/sketch`, and `/design/generate`) [chronicle memory]
- extensions/chronicle/resources/2026-06-01T16-25-00-hlar-10min-memory-summary.md (cwd=browser/chronicle context, rollout_path=extensions/chronicle/resources/2026-06-01T16-25-00-hlar-10min-memory-summary.md, updated_at=2026-06-01T16:25:00+00:00, thread_id=None, manual Chrome QA of login, admin requests, feature flags, and profile editing) [chronicle memory]
- extensions/chronicle/resources/2026-06-01T17-02-00-IGUj-10min-memory-summary.md (cwd=browser/chronicle context, rollout_path=extensions/chronicle/resources/2026-06-01T17-02-00-IGUj-10min-memory-summary.md, updated_at=2026-06-01T17:02:00+00:00, thread_id=None, production deploy follow-through and workflow-editor/dashboard UI diagnosis) [chronicle memory]
- extensions/chronicle/resources/2026-06-01T18-47-00-cnhi-10min-memory-summary.md (cwd=browser/chronicle context, rollout_path=extensions/chronicle/resources/2026-06-01T18-47-00-cnhi-10min-memory-summary.md, updated_at=2026-06-01T18:47:00+00:00, thread_id=None, open beta, OpenRouter service-tier policy, and storefront/admin context in the same product family) [chronicle memory]
### keywords
- /design/canvas, /design/sketch, /design/generate, StudioCanvas.tsx, WorkflowEditor.tsx, DesignDashboardPage.tsx, auth.ts, 127.0.0.1:5174, Requests, Feature Flags, profile editing, open beta, service_tier, /api/v1/key, inference.ts
## User preferences
- When the user asks for the coding menu and related views to "go into side navigation, replacing the normal dashboard navigation" -> keep coding routes aligned with the main app shell instead of leaving them behind an inner tool-only sidebar. [Task 1] [chronicle memory]
- When the user asks whether an agent is hooked up or whether cloud signup is ready -> trace actual source, deploy state, and env readiness before answering instead of treating a recent summary as enough proof. [Task 2] [chronicle memory]
- When the user is unhappy with the dashboard look and says users should generate their own Detour dashboard/custom app -> treat that as a product-surface bug, not just a deploy artifact, and inspect the actual UI composition files. [Task 3] [chronicle memory]
## Reusable knowledge
- The visible coding-shell refactor replaced the old inner coding sidebar with `CODING_NAV`, and the durable route set was Terminal `/coding`, Setup `/coding/setup`, Draft `/coding/draft`, Saved work `/coding/saves`, plus agent pages such as `/coding/opencode`, `/codex`, `/claude`, `/pi`, and `/openrouter`. Shared state lived in `CodingSessionContext`. [Task 1] [chronicle memory]
- The setup surface worth rechecking was the Codex API-key page with `Open terminal · codex`, plus lingering config issues like `Cannot find type definition file for 'bun-types'` and invalid `_ignoreDeprecations` in `tsconfig.json`. [Task 1] [chronicle memory]
- The durable readiness split was explicit: one lane had mock-backed cloud E2E coverage passing, while separate work still chased stale `JOB_TYPES`, autoscaler env ordering, missing dynamic plugin bundles, proxy `ECONNREFUSED`, and deploy/env readiness. [Task 2] [chronicle memory]
- The design-workspace QA path used Playwright for authenticated inspection because the in-app browser could inspect but not seed auth state; the target flows were `/design/canvas`, `/design/sketch`, and `/design/generate`. [Task 3] [chronicle memory]
- The product/UI cleanup direction was one persistent top rail per workspace, inline side panels instead of stacked floating bubbles, and treating generated HTML as an artifact-preview workflow rather than a floating tool island. [Task 3] [chronicle memory]
## Failures and how to do differently
- Symptom: coding pages feel bolted on or lose shared state. Cause: coding routes still live under a separate inner shell or state is not centralized. Do differently: keep coding views in the main app nav and preserve agent/backend/save state through `CodingSessionContext` or the equivalent shared layer. [Task 1] [chronicle memory]
- Symptom: a cloud lane is called green because one E2E suite passed. Cause: mock-backed coverage and live/proxy/readiness failures were conflated. Do differently: separate mock E2E, local smoke, deployed readiness, and manual admin QA, and keep the exact failing lane visible. [Task 2] [chronicle memory]
- Symptom: the dashboard or workfl …

## memory_summary.md

v1
## User Profile
The user uses Codex as an implementation partner across multiple live local repos, browser-heavy product/admin workflows, and occasional one-off build folders. They switch quickly between code, CI/deploy triage, product QA, design/art tooling, social/admin coordination, and infrastructure research. [chronicle memory]
They care about runtime truth over source-only explanation. “Done” usually means a real build, local run, live browser surface, current-head CI result, deploy/env check, or another inspectable artifact. [chronicle memory]
They regularly steer product shape while implementation is underway: Detour Cloud shell/admin/design work, eliza cloud E2E stabilization, Swoosh game-harness scope cleanup, Milady startup/runtime simplification, Apple-platform UI quality, and practical agent-native products. [chronicle memory] [ad-hoc note]
They expect durable rules to stick once stated. This is strongest for Milady’s runtime-app-core guidance and Apple-platform WWDC/HIG/Foundation Models skills, which they want applied proactively later without re-explaining them. [ad-hoc note]
## User preferences
- Reuse the owned checkout, current code, tests, logs, git state, and live run/deploy evidence before giving generalized advice.
- When they ask whether something is “hooked up,” “ready,” or green, verify source plus deploy/env/runtime state instead of inferring from one passing lane or one recent summary. [chronicle memory]
- Keep mock-backed E2E, local smoke, manual browser QA, and deployed readiness as separate lanes; do not collapse them into one status. [chronicle memory]
- For read-only audits or preflights, obey the boundary strictly and report the first real blocker or drift signal instead of “helpfully” fixing it.
- If they push back that a blocker must be fixed rather than worked around, trace the structural cause instead of normalizing the skip. [chronicle memory]
- For Milady startup/runtime work, treat `.understand-anything/master-prompts/runtime-app-core` as required structural guidance; keep UI modules render-only and move behavior into controller/app-core seams. [ad-hoc note]
- Treat `.understand-anything/` as local generated state in Milady work; do not delete, stage, or fold it into cleanup.
- When they ask Codex to learn Apple-platform rules or WWDC guidance, preserve them as durable memory and apply the relevant skills proactively later. [ad-hoc note]
## General Tips
- Search `MEMORY.md` by cwd/project handle first: `dtour-cloud`, `/Users/home/Documents/eliza`, `/Users/home/swoosh`, `/Users/home/Documents/the family`, `/Users/home/Documents/printing-press-library`, `/Users/home/dtour-cloud-agent`, and Milady checkout paths.
- Chronicle context is useful for routing and recent product/admin/browser work, but nearby tabs or chats are not checkout truth until reverified in code or the live app. [chronicle memory]
- Current June 1 high-signal families are: Detour Cloud coding/admin/design QA, eliza cloud Playwright stabilization, Swoosh Scout removal and SwiftPM dependency-shape debugging, Open-LLM-VTuber local setup/avatar tooling, and late-night eliza tray-first / ElizaCloud deployment investigation. [chronicle memory]
- Local Playwright verification may need `/Users/home/.codex/skills/playwright/scripts/playwright_cli.sh` when direct package fetches are blocked. [chronicle memory]
- A recurring environment warning in this machine is `/Users/home/.zshenv:.:1: no such file or directory: /Users/home/.cargo/env`; report it when relevant, but do not confuse it with the primary repo/task failure.
## What's in Memory
### browser/chronicle context and visible dtour-cloud worktrees
#### 2026-06-01
- Detour Cloud coding shell and admin/design QA: dtour-cloud, CODING_NAV, CodingSessionContext, /design/canvas, Feature Flags
  - desc: Search this first for the June 1 Detour Cloud shell refactor, readiness split, design-workspace cleanup, login/admin/profile QA, and dashboard/product-surface follow-through.
  - learnings: Keep coding views in the main shell, separate mock E2E from live readiness, and inspect `WorkflowEditor.tsx` or `DesignDashboardPage.tsx` when the complaint is visual/product, not deploy-only. [chronicle memory]
- Cache storefront port and Convex map: cache-bar, /Users/home/Downloads/cache.html, src/pages/Storefront.tsx, convex/schema.ts
  - desc: Routes to the Detour storefront architecture pass and the correction that the downloaded `cache` artifact is the visual target for the real React/Convex storefront.
  - learnings: Map `src/` plus `convex/*.ts` before porting the static design so the adaptation target is explicit. [chronicle memory]
- POD API and sticker/apparel automation research: Tapstitch, Stickerit API interest form, Printify Developers, Teemill Print API
  - desc: Use for browser-side vendor research when the real question is whether sticker/POD fulfillment can be automated by an agent.
  - learnings: Confirm support/API reality first, then compare fully documented vendors against vendors that only expose support or interest-form paths. [chronicle memory]
### /Users/home/Documents/eliza and cloud-frontend CI context
#### 2026-06-01
- Cloud frontend E2E stabilization and current-head truth: packages/cloud-frontend, cloud-routes.spec.ts, /sandbox-proxy, view-manager-actual-flow.spec.ts, gh pr checks 8112
  - desc: Search this first for June 1 cloud Playwright/browser failures, readiness waits, stale baselines, view-manager smoke fixes, and “is the current head actually red?” questions.
  - learnings: Separate mask/baseline bugs from route waits and mock-shape crashes, and only trust failures that repeat on the current pushed head. [chronicle memory]
### /Users/home/swoosh
#### 2026-06-01
- Harness evolution and Scout removal: SwooshArena, game.list_3d_generation_providers, ScoutMemoryCommands.swift, FluidAudio, Package.swift
  - desc: Search this first when Swoosh work is about 3D provider coverage, Scout/non-gaming removal, or SwiftPM gates blocked by optional dependency shape.
  - learnings: The recurring build blocker was structural package wiring, not just a flaky fetch; remove optional voice deps from the default graph before trusting CLI/build gates. [chronicle memory]
#### 2026-05-29
- Weekly health checks and release-readiness gates: git status --short --branch, .githooks/pre-push, not yet implemented, swift build, swift test
  - desc: Covers the read-only Swoosh health check pattern, drift reporting, placeholder scans, and conservative treatment of incomplete test evidence in `cwd=/Users/home/swoosh`.
  - learnings: Missing hook files and real placeholder hits are failures even with a green `swift build`.
### /Users/home/Documents/Codex/2026-06-01/can-we-get-this-running-on/work/OLV-release
#### 2026-06-01
- Open-LLM-VTuber local setup and avatar tooling: Open-LLM-VTuber, 12393, conf.yaml, model_dict.json, Motion Capture, scripts/openai_avatar_assistant.py
  - desc: Search this first for the local VTuber/Mac setup, persona-vs-model debugging, browser mocap, and realistic “PNG to rigged avatar” planning.
  - learnings: Keep persona presets separate from Live2D model registration, and keep “real 2d” grounded in actual rig/export requirements rather than static PNG assumptions. [chronicle memory]
### /Users/home/Documents/the family
#### 2026-06-01
- ElizaCloud deployment constraints around `PUBLIC_BASE_URL`: ElizaCloud, API Keys, PUBLIC_BASE_URL, PATCH /agents/{id}, POST /provision ignored env
  - desc: Routes to the late June 1 deployment investigation for `the family`, where custom images were possible but public-URL/env injection stayed the real gap.
  - learnings: The actual blocker was create-time env/public URL correctness, not a blanket inability to deploy custom images. [chronicle memory]
#### 2026-05-28
- Telegram/BSC bot MVP and `verify:full`: Safe multisig, Flap, Dexploarer/the-family, sim:full, verify:full
  - desc: Search this first for the Telegram/BSC group-trading bot buildout, pu …

## raw_memories.md

# Raw Memories
Merged stage-1 raw memories (stable ascending thread-id order):
## Thread `019e635e-e0f9-7411-b749-b61948becfda`
updated_at: 2026-05-26T09:30:02+00:00
cwd: /Users/home/Documents/printing-press-library
rollout_path: /Users/home/.codex/sessions/2026/05/26/rollout-2026-05-26T04-20-22-019e635e-e0f9-7411-b749-b61948becfda.jsonl
rollout_summary_file: 2026-05-26T08-20-22-AWAW-printing_press_library_setup_and_marketplace_brainstorm.md
---
description: Repo setup for printing-press-library plus catalog/marketplace brainstorming; key takeaway is that setup needed npm/Go/Python verification and a PATH fix for Go binaries, while the marketplace can be used to build vertical agent packs on top of the catalog.
task: set up repo tooling and answer marketplace/build-use questions
task_group: printing-press-library repo / catalog installer workflow
task_outcome: success
cwd: /Users/home/Documents/printing-press-library
keywords: npm test, go test, registry validation, verify-skill, supply-chain verifier, PyYAML, python3.11 venv, GOPATH/bin, zshrc, zprofile, printing-press-library marketplace, registry.json, MCP metadata
---
### Task 1: Set up the repo/tooling
task: repo setup and verification for printing-press-library
task_group: printing-press-library repo setup
task_outcome: success
Preference signals:
- when the user said "set this up for me", the agent should inspect the repo’s own scripts and verification surfaces rather than assuming a generic app scaffold.
- the user did not ask for a quick partial setup; the broader verification-driven approach across npm, Go, and Python tooling was acceptable.
Reusable knowledge:
- This repo is a catalog/installer repo, so setup should focus on the npm installer workspace plus validation tools, not on rewriting generated catalog files.
- `npm test` in `npm/` runs `npm run build && node --test "dist/tests/**/*.test.js"` and passed with 61 tests.
- `go run ./tools/generate-registry/main.go --validate` is the direct non-mutating catalog validation command and reported `Registry validation passed (181 entries).`
- Full SKILL verification can be run by iterating `library/*/*/` directories and invoking `.github/scripts/verify-skill/verify_skill.py --dir <dir>` on each CLI directory containing `SKILL.md` and `internal/cli/`.
- The repo’s runtime install path depends on `go install`, and `$(go env GOPATH)/bin` was `/Users/home/go/bin` on this machine.
Failures and how to do differently:
- plain `python3 -m unittest` is the wrong discovery shape here because the tests are named `*_test.py`; use `python3 -m unittest discover -p '*_test.py'`.
- Python 3.14 on this machine had a broken venv/pip bootstrap path; use Python 3.11 for the local verifier env instead of trying to force the 3.14 venv.
- `go install`-based installers can appear fine while still being unusable if `$HOME/go/bin` is missing from `PATH`; verify PATH after setup.
- guard optional shell sources with `[ -s file ] && source file` to stop noisy startup errors when helper files are absent.
References:
- `npm ci` in `npm/` succeeded; `npm test` ended with `ℹ tests 61` / `ℹ pass 61` / `ℹ fail 0`.
- `go test ./...` succeeded in both `tools/generate-skills` and `tools/generate-registry`.
- supply-chain verifier fix: `.cache/python-verifier-venv311` with `PyYAML 6.0.3` installed.
- PATH verification went from `missing from PATH` to `login:on PATH` and `interactive:on PATH` after adding `$HOME/go/bin` to `~/.zprofile` and `~/.zshrc`.
- final Go version after upgrade: `go version go1.26.3 darwin/arm64`.
### Task 2: Market/use-case brainstorming
task: identify what can be built with the marketplace/catalog
task_group: product brainstorming on top of the catalog
task_outcome: success
Preference signals:
- when the user clarified "not the app but what i can build with it", they wanted concrete product ideas built on top of the marketplace, not a description of the marketplace itself.
- when the user asked "whats in the marketplace", they wanted a catalog-level breakdown grounded in the current registry rather than an abstract pitch.
Reusable knowledge:
- the catalog currently has 181 tools across 17 categories.
- MCP metadata exists for 163 tools: 145 full, 17 partial, 1 unknown.
- The strongest build surfaces are productivity, travel, commerce, marketing, developer tools, payments/finance, media/research, food/local, devices/home, and project/CRM.
- The highest-level recommendation given was to build vertical agent packs / workflow products rather than a generic platform first.
References:
- Category counts from `registry.json`: ai 3, cloud 4, commerce 15, developer-tools 21, devices 5, education 1, food-and-dining 12, marketing 16, media-and-entertainment 28, monitoring 2, other 15, payments 8, productivity 24, project-management 3, sales-and-crm 7, social-and-messaging 5, travel 12.
- Representative catalog examples mentioned: Notion, Slack, Figma, Nylas, Outlook email/calendar, Cal.com, Airbnb, Booking.com, flight-goat, hotel-goat, seats.aero, Amazon Orders/Seller, Shopify, eBay, FedEx, Instacart, Ahrefs, Google Ads, Google Search Console, Klaviyo, Mailchimp, Apify, Firecrawl, PostHog, Supabase, Stripe, Mercury, Kalshi, Monarch Money, YouTube, Spotify, Wikipedia, Hacker News, arXiv, OpenAlex.
## Thread `019e65ed-5801-73f3-9979-61abdc9f4271`
updated_at: 2026-05-27T23:52:57+00:00
cwd: /Users/home/Documents/milady
rollout_path: /Users/home/.codex/archived_sessions/rollout-2026-05-26T16-15-13-019e65ed-5801-73f3-9979-61abdc9f4271.jsonl
rollout_summary_file: 2026-05-26T20-15-13-uNFf-milady_sync_silent_catch_audit_and_cleanup_loop.md
---
description: root develop sync plus a codebase-wide silent-catch audit and a multi-pass eliza cleanup loop that committed per pass; key takeaway is to commit each coherent pass, verify with package-local typechecks/tests, and watch for disk-full ENOSPC before blaming code
task: sync root develop, audit silent catches, and begin multi-pass cleanup with commits and verification
task_group: milady_repo / eliza workspace maintenance
cwd: /Users/home/Documents/milady
keywords: git fetch, origin/develop, silent catch audit, connector-routes, voice-capture-factory, first-run voice readiness, plugin-local-inference, vitest, typecheck, ENOSPC, zod import, tsconfig path maps, .understand-anything
---
### Task 1: Sync root `milady` to `origin/develop`
task: pull-and-fast-forward root checkout to origin/develop after checking cleanliness
task_group: repo sync
task_outcome: success
Preference signals:
- user asked: "pull a fresh from origin develop" -> future sync requests should check branch tracking/cleanliness before fast-forwarding
- user said: "this always stays .understand-anything/" -> treat `.understand-anything/` as local tool state, never delete/stage/fold into cleanup
Reusable knowledge:
- safe sync flow: `git status --short --branch` -> `git remote -v` -> `git fetch origin develop` -> `git rev-list --left-right --count HEAD...origin/develop` -> `git merge --ff-only origin/develop`
- root checkout was already exactly aligned with `origin/develop` (`0 0` ahead/behind); merge reported `Already up to date.`
Failures and how to do differently:
- none; the only untracked path was the user-approved `.understand-anything/` directory
References:
- `git status --short --branch` -> `## develop...origin/develop` plus `?? .understand-anything/`
- `git rev-list --left-right --count HEAD...origin/develop` -> `0\t0`
- `git merge --ff-only origin/develop` -> `Already up to date.`
### Task 2: Audit silent catch blocks
task: codebase-wide read-only audit for silent catch blocks and swallowed failures
task_group: reliability audit
task_outcome: success
Preference signals:
- user asked: "now audit the codebase for any silent catch blocks" -> future reliability audits should classify silent failure patterns, not just grep for `catch`
- the raw grep was too noisy, so the scan had to be narrowed with a parser and exclusions; future agents should expect inten …
