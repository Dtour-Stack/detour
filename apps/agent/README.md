# apps/agent — The bun-side agent runtime

The bun process the Mac app spawns. Hosts elizaOS' `AgentRuntime`, every
Detour plugin, the RPC socket server, and the HTTP debug surface.

## Where the code lives

| Concern | Path |
|---|---|
| Entrypoint | `src/bun/index.ts` |
| Core services | `src/bun/core/` (runtime, RPC, vault, pensieve, dream, channels, …) |
| Plugins | `src/bun/plugins/` (codex-chatgpt, vault-tools, local-mlx-*, model-router, …) |
| Kernel (tray/window event bus) | `src/bun/kernel/` |
| Features | `src/bun/features/` |
| Build script | `scripts/bundle-agent.ts` |
| Build output | `dist-agent/` |

The TS source still lives under `src/bun/` — this `apps/agent/` directory is
a signpost.

## Build

```sh
bun run build:agent
```

Produces `dist-agent/` with:

```
dist-agent/
├── bun                          ← the bun runtime binary (copied from electrobun's vendored copy or PATH)
├── app/
│   ├── bun/
│   │   ├── index.js             ← bundled from src/bun/index.ts
│   │   ├── pglite.{data,wasm}   ← PGlite
│   │   ├── initdb.wasm
│   │   └── llama/               ← llama-server + bundled embedding model
│   ├── eliza/packages/skills/skills/
│   ├── knowledge/detour-squirrel/
│   ├── node_modules/{pty-manager,node-pty,adapter-types}/
│   ├── carrots/                 ← bundled carrot plugins
│   ├── vector.tar.gz            ← PGLite vector extension
│   ├── fuzzystrmatch.tar.gz
│   ├── Detour.sdef              ← AppleScript dictionary
│   └── DetourHelpers.applescript
```

`bun run build:mac` consumes from here and copies the payload into
`dist/Detour.app/Contents/Resources/app/`.

## No electrobun

Earlier the bun runtime was bundled through `electrobun build --env=dev`
(which produced `build/dev-macos-arm64/Detour-dev.app/Contents/Resources/app/`).
That was 181 MB of payload including React/WKWebView assets the Mac app
doesn't need. `scripts/bundle-agent.ts` replaces that with a direct
`bun build` + targeted asset copy.

## IPC contract

The agent serves a JSON-RPC 2.0 server on `~/.detour/rpc.sock` (see
`src/bun/core/rpc-socket.ts`) and dials `~/.detour/mlx.sock` for Swift-side
MLX/framework work. The HTTP server on `127.0.0.1:2138` is narrow:
`/api/health`, `/api/debug/*`, `/api/eval/*`.

## What the agent owns

- elizaOS `AgentRuntime` composition (`src/bun/core/runtime.ts`)
- Local LLM lifecycle (llama-server + companion)
- Vault, Pensieve, channels (Discord / Telegram / iMessage / X)
- Goal + Dream services
- Activity / trajectory recording
- Worker pool (sub-agent spawning)
- Carrot host

The agent does **no** UI rendering. Tray + windows are 100% the Mac app.
