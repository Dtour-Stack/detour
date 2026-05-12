# Project Learnings

> Managed by `/learn`. Append-only — latest entry wins on conflicts.

## Patterns

### typed-rpc-single-contract
- **Insight:** Detour keeps view-to-Bun IPC in typed RPC fragments under `src/shared/rpc`, composes handlers in `src/bun/core/rpc/registry.ts`, and exposes one view singleton from `src/main/rpc.ts`.
- **Confidence:** 9/10
- **Source:** learn
- **Files:** src/shared/rpc/index.ts, src/bun/core/rpc/registry.ts, src/main/rpc.ts
- **Date:** 2026-05-12

### single-react-entrypoint-view-shells
- **Insight:** All Detour windows share `src/main/index.tsx`, while per-window HTML shells set `window.__detourView` so bundled `views://` URLs avoid fragment handling issues.
- **Confidence:** 9/10
- **Source:** learn
- **Files:** src/main/index.tsx, electrobun.config.ts, src/main/activity.html, src/main/pensieve.html, src/main/browser.html
- **Date:** 2026-05-12

### feature-windows-share-handler-bag
- **Insight:** Kernel features open singleton Electrobun windows through `WindowFactory`, and every window receives the same RPC handler bag built from `RpcDeps`.
- **Confidence:** 8/10
- **Source:** learn
- **Files:** src/bun/kernel/windows.ts, src/bun/kernel/app.ts, src/bun/features/chat/index.ts
- **Date:** 2026-05-12

## Pitfalls

### rpc-migration-doc-stale
- **Insight:** `docs/rpc-migration.md` still lists many outstanding HTTP routes, but current `ApiServer` only exposes `/api/health`, dev-only `/api/debug/action`, and `/api/debug/embedding`.
- **Confidence:** 8/10
- **Source:** learn
- **Files:** docs/rpc-migration.md, src/bun/core/api/server.ts
- **Date:** 2026-05-12

### build-eliza-before-validation
- **Insight:** CI builds vendored eliza packages before Detour typecheck and tests because root imports depend on generated eliza dist/proto outputs.
- **Confidence:** 8/10
- **Source:** learn
- **Files:** package.json, .github/workflows/ci.yml
- **Date:** 2026-05-12

## Preferences

## Architecture

### core-composition-root
- **Insight:** `src/bun/core/index.ts` is the app composition root: it creates vault/config/runtime/pensieve/activity/gateway/inbox/cron/llama/portless services, builds `RpcDeps`, starts the API, and warms the eliza runtime.
- **Confidence:** 9/10
- **Source:** learn
- **Files:** src/bun/core/index.ts
- **Date:** 2026-05-12

### canonical-detour-state-dir
- **Insight:** Detour stores runtime state under `~/.detour`, including PGlite data, vault-backed config, runtime lockfile, agent sandbox, and shared auth symlink behavior.
- **Confidence:** 8/10
- **Source:** learn
- **Files:** src/bun/index.ts, src/bun/core/index.ts, src/bun/core/vault.ts
- **Date:** 2026-05-12

### carrot-worker-plugin-bridge
- **Insight:** Runtime-installable carrots are Bun workers that declare eliza plugin actions/providers/services and call host services through a permissioned bridge.
- **Confidence:** 9/10
- **Source:** learn
- **Files:** src/bun/core/carrots/index.ts, src/bun/core/carrots/types.ts, carrots/cron-tools/worker.ts, carrots/cron-tools/carrot.json
- **Date:** 2026-05-12

## Tools

### detour-validation-gates
- **Insight:** First-party validation is macOS+Bun oriented: `bun run build:eliza`, filtered `bunx tsc --noEmit -p tsconfig.json`, explicit `bun test` over `src/**/*.test.ts`, and `bun scripts/validate-carrot-bridge.ts` for carrot bridge coverage.
- **Confidence:** 8/10
- **Source:** learn
- **Files:** package.json, .github/workflows/ci.yml, scripts/validate-carrot-bridge.ts
- **Date:** 2026-05-12
