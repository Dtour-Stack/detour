# Detour

A macOS menu-bar app that wraps an [elizaOS](https://github.com/elizaOS/eliza) AgentRuntime. Chat with the agent in a popup, watch it think, browse what it remembers, hook it up to Discord / Telegram / iMessage, and run a local embedding server — all from the tray.

> ### Where Detour fits
>
> The thing I actually care about, and where my real work goes, is **[elizaOS/eliza](https://github.com/elizaOS/eliza)** — the agent framework upstream. Detour is downstream of it. If you want to understand the agent runtime, the plugin protocol, or build your own version of any of this, **start there.**
>
> The polished consumer-facing app built on eliza is **[Milady](https://github.com/milady-ai/milady)** — desktop + mobile, larger plugin surface, broader skills, the experience the team actually ships to users. **If you want a complete, supported representation of what eliza can do, use Milady.**
>
> **Detour is a developer's experimental playground.** It is the way **I** choose to run an eliza stack on my own machine — a tray-app sandbox where I cash in on random intrusive thoughts I have about agents ("what if the inbox prompted the agent through the real reply pipeline?", "what if I bundled llama.cpp for free local embeddings?", "what if the tray icon told me whether the agent was alive?"). Things land when I want them, get ripped out when I don't.
>
> So **expect it to break often.** That's the whole point of having a sandbox separate from eliza and Milady. If you want stability, use Milady. If you want to study the framework, use eliza. Detour is the place to watch me poke at it.

---

## Install

macOS (Apple Silicon) only. Builds aren't notarized — they ship ad-hoc signed and the installer strips the macOS quarantine flag for you.

**Stable** (latest tagged release):

```sh
curl -fsSL https://raw.githubusercontent.com/Dexploarer/detour/main/scripts/install.sh | bash
```

**Canary** (rolling build of `main`, may break):

```sh
curl -fsSL https://raw.githubusercontent.com/Dexploarer/detour/main/scripts/install.sh | bash -s -- canary
```

**Specific version**:

```sh
curl -fsSL https://raw.githubusercontent.com/Dexploarer/detour/main/scripts/install.sh | bash -s -- 0.3.0
```

The installer downloads from GitHub Releases, removes `com.apple.quarantine`, and drops `Detour.app` into `/Applications`.

---

## What's in the box (v0.3.0)

| Surface | Where | What |
|---|---|---|
| **Chat** | tray click → popup | Codex/ChatGPT subscription chat (no API key — uses your `~/.codex/auth.json`) |
| **Pensieve > Inbox** | `Cmd+Shift+P` | Notifications + auto-promoted channel signals; programmatic posts drive the agent through eliza's real reply pipeline |
| **Pensieve > Channel feed** | same window | Unified inbound + outbound across Discord / Telegram / iMessage / in-app chat |
| **Pensieve > Memories / Relationships / Graph** | same window | Browse what the agent remembers, who it knows, the graph between them |
| **Activity** | `Cmd+Shift+A` | Trajectories, logs, runtime introspection, tasks, plugins, raw DB |
| **Channels** | `Cmd+Shift+C` | Discord / Telegram / iMessage setup with token validation on save |
| **Settings > Local AI** | `Cmd+,` then "Local AI" | Bundled llama.cpp embedding server status + test button + cloud-fallback OpenAI key |
| **X (Twitter) actions** | agent-callable | `X_POST` and `X_REPLY` actions — the agent posts as @detour_squirrel directly via X's web GraphQL (cookie auth, no developer API key). Setup: paste `X_AUTH_TOKEN` + `X_CT0` cookies into the vault. |

Behind the surfaces:

- **Codex/ChatGPT subscription** for chat (auto-detects from system Codex CLI, no re-auth)
- **Local llama.cpp embedding server** bundled in the .app — bge-small-en-v1.5, 384-dim, ~30 ms per embedding, no network after first model download
- **In-house encrypted vault** (eliza's `@elizaos/vault`) keyed by your macOS keychain
- **PGlite** for local agent memory (memories, embeddings, relationships, trajectories)
- **Channel gateway** that records every cross-channel turn into a unified JSONL feed
- **Inbox** that wraps notifications into the same `messageService.handleMessage` path the chat uses, so the agent reacts to them with its full pipeline (planner → action → REPLY)

---

## Stack

```
Detour.app
├── Electrobun launcher  (native macOS shell, single .app artifact)
├── Bun runtime          (in-process API + WebSocket on :2138)
│   ├── @detour/core               (composition root, vault, channels, gateway, inbox, llama)
│   ├── @detour/plugin-codex-chatgpt    (chat via chatgpt.com/backend-api/codex/responses)
│   ├── @detour/plugin-embedding-openai (OpenAI-compatible client → local llama-server)
│   ├── @detour/plugin-pensieve-tools   (PENSIEVE_* actions for the agent)
│   ├── @detour/plugin-vault-tools      (VAULT_* / LOGIN_* actions)
│   └── llama-server                    (llama.cpp embedding endpoint, lazy-spawned)
└── React UI            (Vite-built; loaded from views:// in prod, localhost:5180 in dev)
    ├── Chat popup window
    ├── Pensieve window  (Inbox, Channel feed, Memories, Relationships, Graph, Templates, Embedding map)
    ├── Activity window  (Trajectories, Logs, Tasks, Autonomy, Plugins, DB, Runtime)
    ├── Channels window
    └── Settings window  (Configuration, Vault, Local AI)
```

The `eliza/` git submodule is pinned to **`origin/develop` HEAD** (not a release tag) — Detour intentionally tracks bleeding-edge eliza so I can pick up Discord / iMessage / Codex orchestrator fixes faster.

---

## Development

```sh
# clone with submodules
git clone --recursive https://github.com/Dexploarer/detour.git
cd detour

# install + build the eliza pieces we depend on
bun install
bun run build:eliza

# in two terminals: one for the React dev server, one for the .app
bun run dev:web      # → packages/web on http://localhost:5180
bun run dev          # → builds + launches Detour-dev.app, hot-reloads from Vite
```

Useful API endpoints (the in-process API on `127.0.0.1:2138`):

```
GET  /api/health
GET  /api/llama/status
POST /api/debug/embedding   # smoke-tests the embedding pipeline end-to-end
GET  /api/inbox
POST /api/inbox             # { kind, title, body, prompt? }
GET  /api/gateway/feed?channel=&direction=&limit=
GET  /api/channels
POST /api/channels/credentials  # validates Discord / Telegram / OpenAI tokens before saving
GET  /api/activity/trajectories
GET  /api/activity/logs
GET  /api/activity/runtime
```

---

## Releasing

Conventional commits on `main` → release-please opens a "chore: release X.Y.Z" PR with bumped versions and CHANGELOG. Merging the PR tags the version and triggers the Release workflow, which builds + ad-hoc signs + uploads `Detour-X.Y.Z-stable.zip` (and `.dmg`) to a GitHub Release.

Every push to `main` also produces a canary build attached to the rolling [`canary`](https://github.com/Dexploarer/detour/releases/tag/canary) release.

See `.github/RELEASING.md` for the long form.

---

## Community

Building on **elizaOS v3**, learning the framework, or experimenting with agents on top of it? The warmest place to talk shop is **[Cozy Devs on Discord](https://discord.gg/BfTrruWcZ)**. Calm, technical, no shilling — just builders sharing what works and what's broken.

Detour's own X/Twitter is **[@detour_squirrel](https://x.com/detour_squirrel)** — that's the agent's account, not mine. Follow if you want to watch a tray-app squirrel post about itself.

---

## Contributing

This is a personal opinionated app. PRs that align with how I want the project to evolve are welcome; PRs that try to broaden it into a generic eliza distribution probably aren't (use Milady or elizaOS for that). If you're not sure, open an issue first.

---

## Credit

- [elizaOS/eliza](https://github.com/elizaOS/eliza) — the AgentRuntime, plugin protocol, and most of the heavy lifting
- [Milady](https://github.com/milady-ai/milady) — upstream agent app that informed Detour's surface choices
- [Electrobun](https://electrobun.dev) — single-binary native shell with Bun runtime
- [llama.cpp](https://github.com/ggml-org/llama.cpp) — bundled for local embeddings
- [PGlite](https://pglite.dev) — Postgres in WASM for in-process memory
