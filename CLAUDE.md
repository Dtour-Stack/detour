# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Detour is a macOS tray app (Apple Silicon) that wraps an [elizaOS](https://github.com/elizaOS/eliza) `AgentRuntime` in a single Electrobun bundle. It is **Dexploarer's personal sandbox** on top of eliza, not a generic elizaOS distribution — expect features to land and disappear. The polished consumer app is **Milady**; the upstream framework is **elizaOS/eliza**. Detour is the developer playground in between.

The `eliza/` git submodule is intentionally pinned to `origin/develop` HEAD (bleeding edge), not a release tag.

## Commands

```sh
# bootstrap (after a fresh clone with submodules)
bun install
bun run build:eliza       # builds every eliza package + plugin Detour depends on

# dev loop
bun run dev               # builds + launches Detour-dev.app, hot-reloads via electrobun watch
bun run start             # same without --watch
bun run typecheck         # tsc --noEmit across the whole tree

# packaging
bun run build:dev         # local .app build
bun run build:canary      # rolling main builds (pushed to GitHub "canary" release)
bun run build:stable      # tagged release builds (release-please drives versioning)

# tests (Bun test runner)
bun run test                                                # Detour suite (src/bun + src/main + src/shared)
bun run test:watch                                          # watch the Detour suite
bun test src/bun/core/runtime-llm-plugin-priority.test.ts   # single file
bun test --watch path/to/file.test.ts                       # watch one file
```

Detour's tests live alongside source (`foo.ts` + `foo.test.ts`) under `src/bun`, `src/main`, `src/shared` (~68 files). **Use `bun run test`** — it scopes to those dirs. Do NOT use bare `bun test` or `bun test src/`: Bun matches the path arg as a substring, so `src/` also pulls in the vendored `eliza/**/src/` suites — and those are **Vitest** tests (they use `vi.mock` module-mocking, which Bun's runner doesn't replicate), so dozens fail under `bun test` even though they pass under eliza's own Vitest. Those failures are a test-runner mismatch in the pinned submodule, not Detour bugs, and none of that code is loaded by Detour's runtime. No Vitest/Jest is wired up at the Detour level.

After **any non-trivial change**, run `bun run typecheck`. The codebase is strict TS and many runtime invariants are enforced only at the type layer.

## Architecture in one diagram

```
Detour.app (Electrobun bundle)
├── Native shell (electrobun)            ─ tray, window factory, CEF/WebKit renderers
├── Bun process  (src/bun/index.ts)      ─ entrypoint: loads .env, boots Core, mounts kernel features
│   ├── core/    (src/bun/core/)         ─ all services + the eliza AgentRuntime live here
│   │   ├── runtime.ts                       AgentRuntime wrapper, plugin composition, send/deliver path
│   │   ├── api/server.ts                    127.0.0.1:2138 — only /api/health, /api/debug/*, /api/eval/*
│   │   ├── rpc/registry.ts                  typed-RPC bag handed to every webview
│   │   ├── rpc/handlers/<group>.ts          one file per feature group (chat, pensieve, vault, …)
│   │   ├── vault.ts / auth.ts / portless.ts / llama/… / inbox/ / channels/ / pensieve/ / activity/
│   │   ├── goal-service.ts / dream-service.ts          conversation goals + local Dreaming mirror
│   │   └── carrots/                         runtime-loaded sandboxed worker plugins ("Carrots")
│   ├── plugins/ (src/bun/plugins/)      ─ Detour-owned eliza plugins (codex-chatgpt, vault-tools,
│   │                                       x-tweets, pensieve-tools, phantom-wallet-tools, gmgn-tools,
│   │                                       discord-media / telegram-media / imessage-media,
│   │                                       audio-generation, media-generation, agent-orchestrator wrapper, …)
│   ├── kernel/  (src/bun/kernel/)       ─ tray, windows, event bus, view-url resolver — bridges Core to UI
│   └── features/ (src/bun/features/)    ─ feature modules registered by the kernel (chat, settings,
│                                          pensieve, activity, browser, portless, pet, gallery,
│                                          shortcuts, notifications, menus)
├── React UI    (src/main/)              ─ single Vite bundle, multiple HTML shells per window
│   ├── index.tsx                            reads window.__detourView from each shell's HTML
│   ├── chat / pensieve / activity / channels / browser / settings / portless / pet / gallery / wallet
│   └── rpc.ts                               Electroview.defineRPC<DetourRPC> + buildViewListeners()
└── Shared      (src/shared/)            ─ wire types + RPC schema (single source of truth)
    ├── index.ts                             shared TS types (no eliza or bun-only deps)
    └── rpc/                                 one file per group, composed in rpc/index.ts → DetourRPC
```

### IPC: typed RPC only — almost no HTTP

Communication between the Bun process and webviews is **typed RPC over postMessage** (Electrobun's `BrowserView.defineRPC<DetourRPC>` ↔ `Electroview.defineRPC<DetourRPC>`). See `docs/rpc-migration.md`. The `127.0.0.1:2138` HTTP server is intentionally narrow:

- `GET /api/health` — liveness probe
- `POST /api/debug/action`, `POST /api/debug/embedding` — dev diagnostics
- `/api/eval/*` — token-gated eval API for external drivers

**To add a new bun↔view method:**
1. Add to `src/shared/rpc/<group>.ts`, intersect into `DetourBunRequests` / `DetourViewRequests` in `src/shared/rpc/index.ts`.
2. Implement in `src/bun/core/rpc/handlers/<group>.ts`.
3. Spread `<group>Requests(deps)` into `buildRpcHandlers` in `src/bun/core/rpc/registry.ts`.
4. Call from the view via `rpc.<methodName>(...)`.

Server → all webviews fan-out goes through `broadcaster.broadcast(name, payload)` in `rpc/registry.ts`. The kernel hooks specific broadcast names (`uiOpenChat`, `uiOpenBrowser`, …) onto an event bus so the windows feature can open windows in response to agent actions.

### The turn lifecycle (chat + inbox)

See `docs/runtime-contract.md` for the exhaustive map. Short version:

- **Chat:** `ChatView` → `rpc.chatSend` → `rpc/handlers/chat.ts` → `runtime.sendMessage` → `messageService.handleMessage` (eliza bootstrap) → `dynamicPromptExecFromState` (wrapped by `dpe-fallback-plugin.ts` for clean cap notices + structured-planner-failure fallback) → action dispatch → callback emits `chatDelta` / `chatComplete` broadcasts.
- **Inbox (Discord / Telegram / iMessage / X DM):** channel gateway emits `MESSAGE_RECEIVED` → `inbox/index.ts` dedupes + persists → `promptAgent` → same `messageService.handleMessage` chain as chat. This is the key invariant — **incoming notifications drive the agent through the same pipeline as chat**, not a separate path.
- **Goal threading:** `goal-service.ts` captures conversation goals fire-and-forget on user turns; the `detour-goal` plugin wraps `CREATE_TASK` / `SPAWN_AGENT` / `START_CODING_TASK` so spawned sub-agents inherit the parent goal. Wrapping is idempotent via the `WRAPPED_FOR_GOAL` marker.

### Window model

The view layer is one React bundle (`src/main/index.tsx`) loaded by **multiple HTML shells**. Each shell (`index.html`, `pensieve.html`, `activity.html`, `browser.html`, `pet.html`, `portless.html`, `gallery.html`) sets `window.__detourView` before the shared bundle runs. The bundle reads that and renders the corresponding root component.

This exists because Electrobun's `views://` scheme handler doesn't strip URL fragments — `views://main/index.html#activity` 404s. Each window must get its own HTML file. When adding a new window:
1. Create `src/main/<view>.html` that sets `window.__detourView = "<view>"`.
2. Register it under `build.copy` in `electrobun.config.ts`.
3. Add a branch to the route switch in `src/main/index.tsx`.
4. Open it via `WindowFactory` (kernel) keyed off the appropriate `uiOpen<X>` broadcast.

### Where the agent lives

`src/bun/core/runtime.ts` is the single composition root for the eliza `AgentRuntime`. It:
- Stitches together built-in eliza plugins (sql, anthropic, openai, discord, telegram, imessage, coding-tools, agent-skills, agent-orchestrator, elizacloud, github, pdf) + every Detour-owned plugin in `src/bun/plugins/`.
- Wraps `agent-orchestrator` service classes in a Proxy so a failing `PTYService.start()` can't abort the whole runtime init (this is load-bearing — node-pty can fail to build cleanly on first install).
- Pins the active LLM plugin to priority 100 so the user's selected provider wins `useModel` resolution (see `runtime-llm-plugin-priority.test.ts`).
- Embedding model is bundled llama.cpp (bge-small-en-v1.5, 384-dim) served by `LlamaServerService`. If the user has `OPENAI_EMBEDDING_API_KEY`, `embedding-openai` plugin handles it. Otherwise `embedding-stub-plugin` returns zero vectors to keep the runtime alive.

### Data dir

Everything user-scoped lives at `~/.detour/` (vault, eliza PGlite db, logs, llama models, audit, action results). Auth is **shared** with other eliza apps via `~/.detour/auth → ~/.eliza/auth` symlink, so the Anthropic / OpenAI Codex subscription you set up in Milady or eliza CLI works in Detour automatically.

## Plugins (Detour-owned, under `src/bun/plugins/`)

Each plugin is a normal `Plugin` object exported as default. Most surface eliza actions:

- **`codex-chatgpt`** — chat via ChatGPT subscription (`chatgpt.com/backend-api/codex/responses`), no API key needed
- **`vault-tools`** — `VAULT_*` / `LOGIN_*` actions for the agent to read/write the in-house vault + browser autofill
- **`pensieve-tools`** — `PENSIEVE_*` actions for memory / relationship / graph queries
- **`x-tweets`** — full X surface via cookie auth; action descriptions weighted by [twitter/the-algorithm](https://github.com/twitter/the-algorithm)
- **`phantom-wallet-tools`** — embedded Phantom Connect (Solana + EVM). User-custody. Bun `phantomGetPortalConfig` returns the values you paste into Phantom Portal (Allowed Origins / Redirect URLs)
- **`gmgn-tools`** — GMGN OpenAPI on `openapi.gmgn.ai`; X-APIKEY + Ed25519 X-Signature; **GMGN-hosted custody**, distinct from Phantom
- **`discord-media` / `telegram-media` / `imessage-media`** — `*_SEND_MEDIA` actions that attach generated images/video to the matching channel via native upload paths
- **`audio-generation` / `media-generation`** — TTS, image, video generation
- **`detour-goal`** — wraps orchestrator actions to thread the active conversation goal into sub-agents
- **`pet`-related (`codex-pets`)** — bundled sprite pets surfaced in the floating pet window

## Carrots (sandboxed worker plugins)

Detour also ships a Carrot host (`src/bun/core/carrots/`) — sandboxed mini-plugins running as Bun Workers with permission-scoped capabilities, modeled on the Bunny Ears system (see `.claude/rules/bunny.md`). The first bundled Carrot is `carrots/cron-tools`. Worker source is loaded directly from disk; the SDK at `src/bun/carrot-sdk/index.ts` is copied path-preserved so the same import works in dev source and packaged `.app`.

## Channel gateway + inbox

`src/bun/core/channels/gateway.ts` is the unified inbound/outbound message bus across Discord / Telegram / iMessage / in-app chat / X. Every cross-channel turn is recorded as a JSONL feed surfaced in Pensieve's channel feed tab. The Inbox (`src/bun/core/inbox/`) wraps **notifications, agent observations, and channel signals** into the same `messageService.handleMessage` pipeline as chat — meaning the agent reacts to a Discord ping with its full planner + action stack, not a shortcut.

## Phantom Connect specifics

Phantom embedded Connect (`@phantom/react-sdk`) lives only on **first-party** surfaces — the main React shell or a dedicated allowlisted wallet webview with its own partition. **Not** arbitrary HTTPS pages loaded in the general agent browser, because Phantom Portal "allowed origins" must match the page origin exactly. The CEF renderer is bundled (`bundleCEF: true` in `electrobun.config.ts`) because WKWebView's stripped UA gets routed to an extension-specific path that 400s on Phantom's `/login/start` after consent — CEF ships a real Chrome UA which keeps Phantom on the standard web flow. This costs ~100MB in the bundle and is intentional.

## Repo-level rules

Two ruleset files in `.claude/rules/` are project instructions and override defaults:

- **`electrobun.md`** — the canonical Electrobun ruleset. Especially: `before-quit` (not `process.on("exit")`) for async shutdown; typed RPC schema in `src/shared/`; CEF + WGPU bundling; **don't mix `sandbox: true` with RPC** (sandbox disables RPC); `views://` for bundled assets; the `<electrobun-webview>` tag is a separate native layer, not in-process like Electron.
- **`bunny.md`** — Bunny Ears / Carrot rules. Relevant because Detour's Carrot host follows the same model.

Detour is **not Electron**. Don't apply Electron patterns (`ipcMain`, `webContents`, `app.whenReady`, `protocol.registerFileProtocol`, etc.). See `.claude/rules/electrobun.md` § "Electrobun vs Electron".

## Plumbing discipline

Before **and** after any routing, endpoint, API, page, controller, handler, middleware, feature wiring, import boundary, state store, adapter, repository, port, service, dependency-injection, RPC handler, server action, background job, event handler, migration, or module/package-boundary change, invoke the `plumber` subagent (`.claude/agents/plumber.md`).

- **PRE-FLIGHT** (before editing): have `plumber` identify the canonical lane, the allowed touch set, the forbidden edges, and the Flow Gate. Implement only inside that lane.
- **POST-FLIGHT** (after editing, against the `git diff`): have `plumber` reconstruct the actual lane and return a Flow Gate result.

Do not declare the task complete until `plumber` returns **Flow Gate Result: PASS**. If it returns **FAIL**, repair the blocking topology violations first. If it returns **UNKNOWN**, state exactly what could not be verified and get explicit user acceptance (with stated risks) before treating the task as done.

The repo standard lane is:

```
surface -> boundary adapter -> application use case -> domain/policy -> port/interface -> implementation adapter
```

In Detour terms this maps to: **view (`src/main`) → typed RPC schema (`src/shared/rpc`) → bun RPC handler (`src/bun/core/rpc/handlers`) → core service (`src/bun/core`) → eliza/Detour plugin or adapter (`src/bun/plugins`)**, with the kernel (`src/bun/kernel`) bridging Core ↔ windows and `src/shared` as the single source of truth for wire types.

Avoid rat-tail topology: views reaching into `src/bun` internals instead of typed RPC; feature-to-feature internal imports (`src/bun/features/*`, `src/main/<view>/*`); a `WindowOpenTarget`/dispatch path that re-derives routing instead of using the shared `window-targets.ts` maps; `shared`/`lib`/`utils`/`helpers` junk drawers; global stores as hidden routing; duplicated workflow ownership; application code importing concrete adapters; domain code importing framework/UI/routing/persistence.

**Architecture checks:** this repo currently has **no** committed automated topology check (no dependency-cruiser / eslint-boundaries / madge / Nx), so `plumber` returns UNKNOWN for graph-level claims until set up. Provision them with the **`plumber-setup` skill** (`.claude/skills/plumber-setup/SKILL.md`) — it installs `dependency-cruiser` (+ `madge`), authors a Detour-tuned layering ruleset enforcing the seams above + `no-circular`, wires `check:flow` / `check:cycles`, **validates they run**, and writes a `.claude/topology.md` baseline. `plumber` invokes this skill (or recommends it) the first time it runs. Until then, `bun run typecheck` is the only enforced boundary check.

## Releases

Conventional commits on `main` → release-please opens a "chore: release X.Y.Z" PR. Merging tags + triggers the Release workflow, which builds + ad-hoc signs + uploads `Detour-X.Y.Z-stable.zip`/`.dmg` to a GitHub Release. Every push to `main` also produces a canary build. The auto-updater only runs when `DETOUR_RELEASE_BASE_URL` is set at build time — CI publishes full bundles without patches and leaves that unset; local devs can opt in.
