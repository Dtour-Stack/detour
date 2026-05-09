# HTTP/WS → typed RPC migration

Per [.claude/rules/electrobun.md](../.claude/rules/electrobun.md): "IPC between
bun and browser contexts uses postMessage, FFI" via typed RPC, NOT a custom
HTTP server. Detour started with HTTP fetch + WebSocket and is migrating in
phases — both layers coexist until the last endpoint moves.

## Architecture

```
Bun main process (src/bun/)                     Webview (src/main/)
─────────────────────────────                   ─────────────────────────────

src/bun/core/rpc/registry.ts        ◄────RPC────►  src/main/rpc.ts
  buildRpcHandlers(deps)                            Electroview.defineRPC<DetourRPC>
  broadcaster.broadcast(name, payload)              messages: buildViewListeners()
  bridgeWsToRpc(api) ────translates WS pushes─────► (per-feature subscribers in
                                                       src/main/rpc-listeners/*)

src/bun/core/api/server.ts                       src/main/api/client.ts
  Bun.serve / fetch routes         ◄─HTTP/WS─►   WebClient (legacy, shrinking)
```

Schema lives at [src/shared/rpc/](../src/shared/rpc/) — one file per feature
group, composed in [src/shared/rpc/index.ts](../src/shared/rpc/index.ts).
Single source of truth for both sides.

## Adding a method (canonical pattern)

1. **Schema** — add to `src/shared/rpc/<group>.ts`:
   ```ts
   export type <Group>Requests = {
     myMethod: { params: { id: string }; response: { ok: true } };
   };
   ```
   Then intersect into `DetourBunRequests` in `src/shared/rpc/index.ts`.
   **Empty groups are NOT intersected** — `Record<string, never>` collapses
   the type to an index signature that breaks per-key handler typechecking.

2. **Handler** — add to `src/bun/core/rpc/handlers/<group>.ts`:
   ```ts
   export function <group>Requests(deps: RpcDeps) {
     return {
       myMethod: async (params: { id: string }): Promise<{ ok: true }> => {
         await deps.<service>.doThing(params.id);
         return { ok: true };
       },
     };
   }
   ```
   Then spread into `buildRpcHandlers` in
   [src/bun/core/rpc/registry.ts](../src/bun/core/rpc/registry.ts).

3. **Call site** — replace `client.myMethod(...)` with
   `rpc.request.myMethod({ id })` in `src/main/`.

4. **HTTP route** — once all call sites move, delete the corresponding
   route in [src/bun/core/api/server.ts](../src/bun/core/api/server.ts).

## Adding a server-push message (replaces WS broadcast)

1. **Schema** — add to `src/shared/rpc/<group>.ts`:
   ```ts
   export type <Group>Messages = {
     thingChanged: { id: string };
   };
   ```
   Intersect into `DetourBunMessages` in `src/shared/rpc/index.ts`.

2. **Bridge entry** — translate the legacy WS `kind` to the RPC name in
   `translateWsToRpc` in
   [src/bun/core/rpc/registry.ts](../src/bun/core/rpc/registry.ts):
   ```ts
   case "thing:changed":
     return { name: "thingChanged", payload: { id: msg.id } };
   ```
   Now every `api.publish({kind: "thing:changed", ...})` site automatically
   reaches webviews via typed RPC AND legacy WS — no behavioral change
   until WS is deleted.

3. **View listener** — add to `src/main/rpc-listeners/<group>.ts`:
   ```ts
   const subscribers = new Set<Listener>();
   export function on<Thing>Changed(listener: Listener) { ... }
   export function <group>Messages() {
     return { thingChanged: (payload) => { for (const fn of subscribers) fn(payload); } };
   }
   ```
   Then spread into `buildViewListeners` in
   [src/main/rpc-listeners/index.ts](../src/main/rpc-listeners/index.ts).

4. **Replace WS subscription** — components that did
   `client.on((m) => { if (m.kind === "thing:changed") ... })` switch to
   `on<Thing>Changed((payload) => ...)`.

5. **Delete WS publish** — once all call sites use the RPC subscriber,
   replace `api.publish({kind: "thing:changed", ...})` with
   `deps.broadcaster.broadcast("thingChanged", ...)` directly. Remove the
   bridge entry. Eventually delete the WsServerMessage variant.

## Migrated

| Group | Status | Verified |
|---|---|---|
| `vaultListBackends` | ✓ | ✓ |
| `provider:changed` (WS→RPC bridge active) | ✓ bridge | not yet via RPC |

## Outstanding HTTP endpoints

- `/api/health`
- `/api/providers`, `/api/providers/active`, `/api/providers/openrouter/models`
- `/api/auth/providers`, `/api/auth/accounts`, `/api/auth/flows/*`
- `/api/backends/enabled`, `/api/backends/install`, `/api/backends/<id>/{signin,signout,diagnose}`
- `/api/vault/{inventory,stats,keys}`
- `/api/saved-logins`, `/api/saved-logins/<source>/<id>`
- `/api/config/{models,window,agent,character}`
- `/api/ui/preferences`
- `/api/llama/status`, `/api/llama/restart`, `/api/llama/download-progress`
- `/api/external/open`
- `/api/window/{hide,pin,resize}`
- `/api/browser/commands`, `/api/browser/permissions`
- `/api/cron/*`
- `/api/pensieve/*` (templates, template-vars, memories, knowledge,
  embedding-map, chronicler, relationships, graph)
- `/api/activity/*` (logs, runtime, trajectories, tasks, autonomy, plugins, db)
- `/api/channels/*`, `/api/channels/discord/{guilds,backfill,catch-up}`
- `/api/portless/*`
- `/api/owner-bind/*`
- `/api/inbox/*`, `/api/gateway/{feed,identities}`
- `/api/os/permissions`, `/api/os/permissions/<id>/open`
- `/api/routing`
- `/api/debug/action` (dev-only — stays HTTP per design)

## WS messages still active (bridged or pending)

- `chat:delta`, `chat:complete`, `chat:error` — chat streaming, OUT OF SCOPE
  for current migration phase
- `provider:changed` — bridged to `providerChanged`
- `auth:flow-update` — pending (providers+auth migration)
- `backend:changed` — bridged to `backendChanged`
- `ui:open-settings`, `ui:open-browser` — pending (window/UI migration)
- `browser:command` — pending (browser migration)
- `ui:preferences-changed` — pending (config migration)

## Migration order

Phase 1 work (this session, parallel agents in worktrees):
1. **vault remainder** — `/api/backends/enabled`, `/api/backends/install`,
   `/api/backends/<id>/{signin,signout,diagnose}`, `/api/vault/*`,
   `/api/saved-logins/*`
2. **config** — `/api/config/{models,window,agent,character}`,
   `/api/ui/preferences`
3. **providers + auth** — `/api/providers/*`, `/api/auth/*`; first
   `auth:flow-update` server-push migration
4. **llama + window + external** — small leaves
5. **channels** — channels/credentials/discord
6. **pensieve** — large surface
7. **activity** — large surface
8. **browser** — browser/commands, browser/permissions
9. **cron + owner-bind + inbox + gateway** — small surfaces
10. **portless + os** — independent

Out of scope this session: chat streaming, `/api/debug/action`.

## Why phased

- ~80 HTTP endpoints + ~10 WS message kinds. One mega-PR is unreviewable.
- WebClient is used in ~50 places across `src/main/`. Updating all together
  risks breakage with no rollback granularity.
- Phased migration keeps both paths working; each phase ends with a verified
  reduced HTTP surface.
