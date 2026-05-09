# HTTP/WS → typed RPC migration

Per [.claude/rules/electrobun.md](../.claude/rules/electrobun.md): "IPC between
bun and browser contexts uses postMessage, FFI" via typed RPC, NOT a custom
HTTP server. Detour started with HTTP fetch + WebSocket and is migrating in
phases — both layers coexist until the last endpoint moves.

## Architecture

```
Bun main process (src/bun/)                     Webview (src/main/)
─────────────────────────────                   ─────────────────────────────
                                                
features/chat/index.ts                          rpc.ts                       
  rpc: { handlers: { ... } }       ◄────RPC────►  Electroview.defineRPC<DetourRPC>
                                                
core/api/server.ts                              api/client.ts                
  Bun.serve / fetch routes         ◄─HTTP/WS─►  WebClient (legacy, shrinking)
```

Schema lives at [src/shared/rpc.ts](../src/shared/rpc.ts) — single source of
truth for both sides. Each migrated method gets:

1. A new entry in `DetourRPC.bun.requests` (or `messages`)
2. A handler in [src/bun/features/chat/index.ts](../src/bun/features/chat/index.ts)'s
   `rpc.handlers.requests` block (or wherever the relevant window is created)
3. View call site updated from `client.X()` → `rpc.request.X({})`
4. (Eventually, after all sites move) the HTTP route in
   [src/bun/core/api/server.ts](../src/bun/core/api/server.ts) gets deleted

## Migrated

| Method | Replaces | Verified |
|---|---|---|
| `vaultListBackends` | `GET /api/backends` (`client.detectBackends()`) | ✓ |

## Outstanding HTTP endpoints (top-level groups)

- `/api/health`
- `/api/providers`, `/api/providers/active`, `/api/providers/openrouter/models`
- `/api/auth/providers`, `/api/auth/accounts`, `/api/auth/flows/*`
- `/api/backends/enabled`, `/api/backends/install`, `/api/backends/<id>/{signin,signout,diagnose}`
- `/api/vault/{inventory,stats,keys}`
- `/api/config/{models,window,agent,character}`
- `/api/llama/status`, `/api/llama/restart`, `/api/llama/download-progress`
- `/api/external/open`
- `/api/window/{hide,pin,resize}`
- `/api/browser/commands`, `/api/browser/permissions`
- `/api/cron/*`
- `/api/pensieve/*` (graph, memory, relationships, templates, chronicler)
- `/api/activity/*` (autonomy, db, logs, plugins, runtime, tasks, trajectories)
- `/api/channels/*`
- `/api/portless/*`
- `/api/owner-bind/*`
- `/api/debug/action` (dev-only, stays HTTP)

WebSocket messages (`chat:send`, `chat:delta`, `chat:complete`, `auth:flow-update`,
`provider:changed`, etc.) become RPC `messages` (server-push, fire-and-forget)
in the same migration.

## Migration order (proposed)

1. **vault** (in progress) — small surface, no streaming, low risk
2. **config** (`/api/config/*`) — pure GET/PUT
3. **providers + auth** — has WebSocket flow updates → first `messages` migration
4. **llama, window, external** — small leaf endpoints
5. **cron, pensieve, activity** — large, do as a group when ready
6. **chat send/delta** — last, since it's the chat hot path; needs careful
   verification of streaming via RPC `messages`
7. **portless, browser** — independent surfaces, migrate when convenient
8. Delete `Bun.serve` HTTP server + `WebClient` once last endpoint moves

## Why not migrate everything at once?

- ~80 HTTP endpoints + ~10 WS message kinds. One mega-PR is unreviewable.
- WebClient is used in ~50 places across `src/main/`. Updating all together
  risks breakage with no rollback granularity.
- Phased migration keeps both paths working; each phase ends with a verified
  reduced HTTP surface.
