# HTTP/WS → typed RPC migration

Status: **complete for product traffic.** Per
[.claude/rules/electrobun.md](../.claude/rules/electrobun.md), IPC between
bun and browser contexts uses postMessage + FFI via typed RPC, not a custom
HTTP server. The migration finished in phases; only three intentional HTTP
routes remain (see "Remaining HTTP surface" below).

## Architecture

```
Bun main process (src/bun/)                     Webview (src/main/)
─────────────────────────────                   ─────────────────────────────

src/bun/core/rpc/registry.ts        ◄────RPC────►  src/main/rpc.ts
  buildRpcHandlers(deps)                            Electroview.defineRPC<DetourRPC>
  broadcaster.broadcast(name, payload)              messages: buildViewListeners()

src/bun/core/api/server.ts                       (no view-side client)
  GET  /api/health           — liveness probe
  POST /api/debug/action     — dev-only action invocation
  POST /api/debug/embedding  — embedding-pipeline diagnostic
```

Schema lives at [src/shared/rpc/](../src/shared/rpc/) — one file per feature
group, composed in [src/shared/rpc/index.ts](../src/shared/rpc/index.ts). The
schema is the single source of truth for both sides.

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

3. **Call site** — `rpc.request.myMethod({ id })` in `src/main/`.

## Adding a server-push message

1. **Schema** — add to `src/shared/rpc/<group>.ts`:
   ```ts
   export type <Group>Messages = {
     thingChanged: { id: string };
   };
   ```
   Intersect into `DetourBunMessages` in `src/shared/rpc/index.ts`.

2. **Emit** — from any service holding `deps.broadcaster`:
   ```ts
   deps.broadcaster.broadcast("thingChanged", { id });
   ```
   The broadcaster fans the message out to every registered webview via the
   electrobun postMessage bridge and evicts any dead send handle it
   discovers along the way.

3. **View listener** — add to `src/main/rpc-listeners/<group>.ts`, then
   spread into `buildViewListeners` in
   [src/main/rpc-listeners/index.ts](../src/main/rpc-listeners/index.ts):
   ```ts
   const subscribers = new Set<Listener>();
   export function on<Thing>Changed(listener: Listener) { ... }
   export function <group>Messages() {
     return { thingChanged: (payload) => { for (const fn of subscribers) fn(payload); } };
   }
   ```

## Remaining HTTP surface

These three routes are kept on HTTP **by design**, not awaiting migration:

| Route | Purpose | Why HTTP |
|---|---|---|
| `GET /api/health` | Liveness probe + version | external tooling pings this; needs to work even when no webview is open |
| `POST /api/debug/action` | Invoke an action by name (dev builds only) | bypasses the LLM action selector — used from `curl` during plugin development |
| `POST /api/debug/embedding` | End-to-end embedding-pipeline diagnostic | intentionally bypasses RPC plumbing so it can detect mounting issues that would also break RPC |

`/api/debug/*` are gated to Detour-dev.app builds (or
`DETOUR_ALLOW_DEBUG_API=1`) and are not exposed in canary/stable artifacts.

The legacy WS push channel (`api.publish({kind})`) is **fully removed**.
Every former WS push is now `broadcaster.broadcast(name, payload)` with a
typed schema. There is no WS→RPC bridge left to maintain.

## State invariants

- `RuntimeService.build` / `rebuild` is serialized through
  `enqueueSerializedBuild` — no overlapping initialization races.
- `CronService`, `InboxService`, and `ChannelGatewayService` use per-key
  async locks (see `src/bun/core/async-lock.ts`) for the in-memory state
  they hold behind disk persistence (jobs map, status overrides, identity
  records). This replaces ad-hoc Promise-chain locks.
- `broadcaster` snapshots its `openWindows` set on each call and evicts
  send handles that throw, so a torn-down window can't poison subsequent
  broadcasts.
