# Detour apps/

Three logically separate apps live in this repo. The directories here are
**signposts** — actual code still lives at the historical paths during the
incremental cutover. Each subdir's README explains what's "in" that app and
where the code currently sits.

```
apps/
├── mac/              # The native macOS app (Swiftun + bundled bun runtime)
├── agent/            # The bun-side agent runtime (eliza + plugins + services)
└── legacy-electrobun/# The pre-consolidation electrobun app (deprecated)
```

## Quick map

| App | What it is | Lives at | Builds via |
|---|---|---|---|
| `apps/mac/` | The Detour macOS app users actually launch | `build-assets/swiftun-shell/` (Swift) + bun runtime bundle | `bun run build:mac` |
| `apps/agent/` | The bun process Mac app spawns to run eliza | `src/bun/` (TS source) | `bun run build:agent` |
| `apps/legacy-electrobun/` | The old all-Electrobun .app — no longer the shipping artifact | `electrobun.config.ts` + `src/main/` (React) | `bun run build:dev` (legacy) |

## The shipping chain

The user runs **`dist/Detour.app`**, which is `apps/mac/` containing a bundled
copy of `apps/agent/`'s output. The Swift binary spawns the bundled `bun` to
run the agent process. The agent talks to Swift over two Unix sockets
(`~/.detour/{rpc,mlx}.sock`).

```
┌─────────────────────────────────────────┐
│  dist/Detour.app  (apps/mac)            │
│  ┌────────────────┐  ┌────────────────┐ │
│  │ Detour (Swift) │←─│ bun runtime    │ │
│  │  - tray        │  │  (apps/agent)  │ │
│  │  - all windows │  │  - eliza       │ │
│  │  - MLX socket  │  │  - plugins     │ │
│  └────────────────┘  └────────────────┘ │
└─────────────────────────────────────────┘
```

## Why electrobun is legacy

The Mac app used to be electrobun-built: WKWebViews loading React surfaces
from `views://main/index.html`. We consolidated everything into native
SwiftUI (Settings, Pensieve, Activity, Chat, Browser, Gallery, Workspace) so
WKWebView + React are no longer needed. Electrobun's only remaining role is
producing the bundled bun runtime — which `apps/agent/` now produces directly
without electrobun.

`bun run build:dev` (electrobun) still works for the legacy build but is
unnecessary for the Mac app build.
