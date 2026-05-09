---
description: Rules for building and maintaining the Bunny Ears Electrobun runtime and its Carrot ecosystem
globs: "bunny/**/*.ts,bunny/**/*.tsx,bunny/**/*.html,bunny/**/*.css,bunny/**/*.json,bunny/**/electrobun.config.ts"
alwaysApply: false
---

# Bunny Ears Ruleset

## Overview

Bunny Ears is a tray-first Electrobun runtime that manages "Carrots" — sandboxed mini-apps running as Bun Workers with optional webviews. It lives at `bunny/ears/` with test carrots at `bunny/test-carrots/`.

## Architecture

```
bunny/
├── ears/                          # Bunny Ears runtime app
│   ├── electrobun.config.ts       # App config (tray-first, WGPU, codesigned)
│   ├── src/
│   │   ├── bun/                   # Main process (BunnyEarsRuntime singleton)
│   │   │   ├── index.ts           # Runtime: tray, carrot lifecycle, RPC, auth, Hop
│   │   │   ├── carrotStore.ts     # Carrot install/uninstall/registry persistence
│   │   │   ├── carrotBuilder.ts   # Builds carrot source into runnable bundles
│   │   │   ├── carrotArtifacts.ts # Artifact extraction (tarball, update.json)
│   │   │   ├── carrotConsent.ts   # Permission consent request construction
│   │   │   └── workerPermissions.ts # Maps CarrotPermissionGrant → Bun.WorkerPermissions
│   │   ├── mainview/              # Dashboard UI (carrot grid, install, consent)
│   │   │   ├── index.ts           # Electroview RPC client
│   │   │   ├── index.html         # Dashboard shell
│   │   │   └── index.css
│   │   ├── carrot-runtime/        # Carrot SDK (injected into carrot builds)
│   │   │   ├── types.ts           # All shared types: permissions, manifests, messages
│   │   │   ├── bun.ts             # Mock Electrobun API for carrot workers
│   │   │   └── view.ts            # View-side carrot client (createCarrotClient)
│   │   └── types/                 # Ambient type declarations
│   ├── scripts/                   # Build hooks (sync-wgpu, build-bundled-carrots)
│   └── tests/                     # Integration tests (bun:test)
└── test-carrots/                  # Reference carrot implementations
    ├── charlie/                   # Window-mode carrot (counter, notifications)
    │   ├── carrot.json
    │   ├── worker.js
    │   └── web/
    └── forrager/                  # Background-mode carrot (tray-only, hidden view)
        ├── carrot.json
        └── worker.js
```

## Carrot Model

### carrot.json Manifest

Every carrot is defined by a `carrot.json` at its root:

```json
{
  "id": "charlie",
  "name": "Charlie",
  "version": "0.0.1",
  "description": "A visible Carrot with a counter and notifications.",
  "mode": "window",
  "permissions": {
    "host": { "windows": true, "notifications": true, "storage": true },
    "bun": { "read": true, "write": true },
    "isolation": "shared-worker"
  },
  "view": {
    "relativePath": "views/index.html",
    "title": "Charlie Carrot",
    "width": 440,
    "height": 520
  },
  "worker": {
    "relativePath": "worker.js"
  }
}
```

**Rules for manifests:**
- `mode` is `"window"` or `"background"` — background carrots have hidden views and run from the tray
- `permissions.host` controls: `windows`, `tray`, `notifications`, `storage`
- `permissions.bun` controls: `read`, `write`, `env`, `run`, `ffi`, `addons`, `worker`
- `permissions.isolation` is `"shared-worker"` or `"isolated-process"`
- `view.hidden: true` for background carrots that don't need a visible window
- `view.relativePath` points to the entry HTML within the built carrot directory
- `worker.relativePath` points to the worker JS file

### Carrot Modes

- **window**: Has a visible BrowserWindow. Requires `host.windows` permission. Auto-stops when all windows close.
- **background**: Runs headless from the tray. Has a hidden controller webview. Requires `host.tray` permission. Started automatically on boot.

### Carrot Install Sources

- **prototype**: Bundled with the app (e.g., Dash). Immutable, can't be reinstalled.
- **local**: From a source directory on disk. Supports dev mode (auto-rebuild on change).
- **artifact**: From a `.tar.zst` tarball or `update.json`. Supports updates via hash checking.

## Permission System

### Types (`src/carrot-runtime/types.ts`)

```typescript
type HostPermission = "windows" | "tray" | "notifications" | "storage";
type BunPermission = "read" | "write" | "env" | "run" | "ffi" | "addons" | "worker";
type CarrotIsolation = "shared-worker" | "isolated-process";

type CarrotPermissionGrant = {
  host?: Partial<Record<HostPermission, boolean>>;
  bun?: Partial<Record<BunPermission, boolean>>;
  isolation?: CarrotIsolation;
};

type CarrotPermissionTag = `host:${HostPermission}` | `bun:${BunPermission}` | `isolation:${CarrotIsolation}`;
```

**Rules for permissions:**
- Always use `normalizeCarrotPermissions()` to convert legacy array formats to the canonical `CarrotPermissionGrant` shape
- Use `flattenCarrotPermissions()` to get a flat `CarrotPermissionTag[]` for display
- Use `hasHostPermission(grant, permission)` and `hasBunPermission(grant, permission)` for checks
- Use `mergeCarrotPermissions(defaults, overrides)` when combining base + requested permissions
- Worker permissions are derived via `toBunWorkerPermissions(grant)` → `Bun.WorkerPermissions`

### Consent Flow

1. `buildCarrotPermissionConsentRequest(prepared, requestId)` builds a consent plan
2. If new/changed permissions detected, a `CarrotPermissionConsentRequest` is shown in the dashboard
3. User approves/denies via `respondToConsent({ requestId, approved })`
4. On approval, carrot is installed with the granted permissions
5. `changedPermissions` tracks what's new since last install

## Runtime (`BunnyEarsRuntime`)

The runtime is a singleton class in `src/bun/index.ts` that owns:

- **Tray**: System tray with dynamic menu (extended by dash carrot via `dashTrayExtension`)
- **Carrots**: `Map<string, CarrotInstance>` — all installed carrots
- **Application Menu**: Tracks active owner, forwards clicks to the focused carrot
- **Context Menu**: Tracks active owner, forwards clicks
- **Auth**: Device token, access token, instance registration
- **Hop**: WebSocket bridge for remote browser access
- **Farm**: BrowserWindow for the Farm UI
- **Update status**: `idle | checking | downloading | update-ready | error`

**Rules for runtime:**
- `exitOnLastWindowClosed: false` — tray-first, never auto-quit
- Background carrots are auto-started in `boot()`
- `before-quit` is used for cleanup (save auth, mark instance offline)
- Tray menu is rebuilt via `buildTrayMenu()` whenever dash extension changes
- Application menu ownership switches when a carrot window gains focus

### CarrotInstance

Each running carrot is wrapped in a `CarrotInstance` that manages:
- **Worker**: `Bun.Worker` with permission-scoped capabilities
- **Controller Windows**: `Map<string, BrowserWindow>` — one or more webviews
- **Tray**: Optional per-carrot tray (background carrots)
- **Application Menu**: Per-carrot menu, activated on window focus
- **Logs**: In-memory ring buffer (last 24 entries), surfaced in dashboard
- **Web Clients**: WebSocket connections for remote UI
- **Bunny Window**: Floating bunny overlay (transparent, always-on-top)

**Rules for CarrotInstance:**
- Worker is created with `type: "module"` and permission-scoped via `toBunWorkerPermissions()`
- On worker `onerror`, the carrot is stopped
- Init context (statePath, logsPath, permissions, authToken, channel) is sent to worker on start
- Window events (focus, move, resize, close) are forwarded to the worker as events
- `emit-view` action fans out to all controller windows, web clients, and Hop browsers

## Carrot SDK

### Bun-side (`src/carrot-runtime/bun.ts`)

Provides a mock Electrobun API for carrot workers. Carrots import from this module instead of `electrobun/bun`:

```typescript
import { BrowserWindow, Tray, Utils, app, Carrots, ApplicationMenu, ContextMenu } from "./carrot-runtime/bun";
```

**Available APIs:**
- `BrowserWindow` — create/manage windows (proxied to host via actions)
- `Tray` — system tray (proxied to host)
- `Utils` — openFileDialog, openPath, showItemInFolder, clipboardWriteText, showNotification, quit
- `Screen` — getPrimaryDisplay, getCursorScreenPoint
- `Carrots` — invoke, emit, list, start, stop (cross-carrot communication)
- `ApplicationMenu` — setApplicationMenu, on("application-menu-clicked")
- `ContextMenu` — showContextMenu, on("context-menu-clicked")
- `app` — manifest, permissions, statePath, logsPath, getWindowFrame, openManager, quit

**Rules for SDK bun:**
- All host interactions go through `carrotRuntime.sendAction()` (fire-and-forget) or `carrotRuntime.requestHost()` (request-response)
- `CarrotRuntimeBridge` is a singleton (`carrotRuntime`) — one per worker
- Window IDs are auto-generated (`window-1`, `window-2`, ...)
- `RuntimeWindow` tracks frame state locally, synced from host events
- `Updater` is stubbed (throws "not implemented")

### View-side (`src/carrot-runtime/view.ts`)

```typescript
import { createCarrotClient } from "./carrot-runtime/view";

const client = createCarrotClient();
client.on("boot", (info) => { ... });
await client.invoke("myMethod", { param: 1 });
```

**Rules for SDK view:**
- `createCarrotClient()` returns `{ rpc, electroview, bootInfo, hasPermission, invoke, on }`
- `carrotBoot` message delivers manifest + permissions on DOM ready
- `runtimeEvent` messages are dispatched to registered handlers
- `invoke()` proxies through the Electroview RPC to the bun-side handler

## Dashboard (`src/mainview/`)

The dashboard is the main Bunny Ears UI — a grid of installed carrots with install/launch/stop/uninstall controls.

**Rules for dashboard:**
- RPC schema (`DashboardRPC`) is defined in both `index.ts` (bun) and `mainview/index.ts` (view) — keep them in sync
- `dashboardChanged` message triggers full re-render
- Consent modal uses `data-open` attribute and `aria-hidden` for accessibility
- HTML escaping via `escapeHtml()` for all user-provided strings
- Buttons are disabled based on carrot state (stopped carrots can't be stopped, prototypes can't be reinstalled)

## Build System

### electrobun.config.ts

```typescript
export default {
  app: { name: "Bunny Ears", identifier: "ai.electrobunny.ears", version: "0.0.1" },
  runtime: { exitOnLastWindowClosed: false },
  build: {
    wgpuVersion: "0.2.3",
    bun: { entrypoint: "src/bun/index.ts" },
    views: {
      mainview: { entrypoint: "src/mainview/index.ts" },
      "carrot-sdk-view": { entrypoint: "src/carrot-runtime/view.ts" },
    },
    copy: {
      "src/mainview/index.html": "views/mainview/index.html",
      "src/mainview/index.css": "views/mainview/index.css",
      "src/carrot-runtime/bun.ts": "carrot-runtime/bun.ts",
    },
    mac: { codesign: true, notarize: true, createDmg: true, bundleCEF: false, bundleWGPU: true },
    linux: { bundleCEF: false, bundleWGPU: true },
    win: { bundleCEF: false, bundleWGPU: true },
  },
  release: { baseUrl: "https://ears.electrobunny.ai/" },
} satisfies ElectrobunConfig;
```

**Rules for config:**
- `carrot-sdk-view` view bundles the SDK view module — injected into carrot builds via `BUNNY_EARS_SDK_VIEW_MODULE` env var
- `carrot-runtime/bun.ts` is copied raw (not bundled) — injected into carrot builds via `BUNNY_EARS_SDK_BUN_MODULE` env var
- WGPU is bundled on all platforms (Dawn for GPU-native rendering)
- CEF is not bundled (uses native webviews)

### Carrot Build Pipeline

1. `carrotBuilder.buildCarrotSource(sourceDir, outDir)` builds a carrot from source
2. Reads `carrot.json` (or constructs from `electrobun.config.ts` if absent)
3. Checks for custom build script: `buildCarrot` or `default` export from `<sourceDir>/electrobun.config.ts`
4. Default build: copies worker, bundles view with SDK injected, copies static assets
5. Custom builds receive a `CustomBuildContext` with `{ sourceDir, outDir, manifest, sdkViewModule, sdkBunModule, defaultBuild }`

**Rules for carrot builds:**
- SDK module paths are resolved from env vars (`BUNNY_EARS_SDK_VIEW_MODULE`, `BUNNY_EARS_SDK_BUN_MODULE`) or fall back to `../Resources/app/` paths
- Custom build scripts can call `context.defaultBuild()` for the standard pipeline plus extras
- Build output goes to `<outDir>/` with `carrot.json`, `worker.js`, `views/`, and any static assets

### Carrot Artifact Pipeline

1. `carrotArtifacts.prepareArtifactPayloadFromPath(path)` handles `.tar.zst` and `update.json`
2. Extracts tarballs using `zig-zstd` + `tar`
3. Resolves `update.json` to find the correct platform/arch tarball
4. Returns `PreparedArtifactPayload` with extracted dir, source info, and cleanup function

## Testing

Integration tests live in `tests/carrot.integration.test.ts` using `bun:test`.

**Rules for tests:**
- Use `bun:test` (`describe`, `test`, `expect`, `afterEach`)
- Set `BUNNY_EARS_SDK_VIEW_MODULE` and `BUNNY_EARS_SDK_BUN_MODULE` env vars to point at source (not built) SDK modules
- Set `BUNNY_EARS_ZSTD_BIN` for artifact extraction tests
- Test carrots live in `bunny/test-carrots/` — reference implementations for window and background modes
- Tests cover: manifest parsing, permission normalization, consent request building, carrot building, artifact preparation, worker creation, worker messaging
- Clean up temp directories in `afterEach`

## Key Patterns

### Message Flow (Worker → Host → View)

```
Worker                    CarrotInstance              Controller Window
  |                            |                            |
  |-- postMessage(request) --> |                            |
  |                            |-- handleWorkerMessage()    |
  |                            |-- invoke(method, params)   |
  |                            |-- worker.postMessage() --> |
  |                            |                            |-- handle message
  |                            |                            |-- rpc request/response
  |                            |<-- postMessage(response) - |
  |<-- postMessage(response) - |                            |
```

### Cross-Carrot Communication

```typescript
// In carrot A's worker:
await Carrots.invoke("carrot-b-id", "methodName", { param: 1 });
Carrots.emit("carrot-b-id", "eventName", { data: 123 });
```

### Adding a New Host API for Carrots

1. Add the method to `HostRequestMessage.method` union in `types.ts` (for request-response)
2. Or add the action to `HostActionMessage.action` union (for fire-and-forget)
3. Handle it in `CarrotInstance.handleHostRequest()` or `handleHostAction()`
4. Expose it in `carrot-runtime/bun.ts` via `carrotRuntime.requestHost()` or `carrotRuntime.sendAction()`

### Adding a New Permission

1. Add to `HostPermission` or `BunPermission` union in `types.ts`
2. Add to `HOST_PERMISSION_ORDER` or `BUN_PERMISSION_ORDER` in `carrotConsent.ts`
3. Add to `flattenCarrotPermissions()` switch/loop
4. Add to `toBunWorkerPermissions()` if it's a bun permission
5. Add display label in `formatPermissionValue()` in `mainview/index.ts`

## Imports

- **Runtime bun**: `import { ... } from "electrobun/bun"` + `import type { ... } from "../carrot-runtime/types"`
- **Runtime view (dashboard)**: `import { Electroview } from "electrobun/view"` + `import type { ... } from "../carrot-runtime/types"`
- **Carrot SDK bun**: `import { carrotRuntime } from "./carrot-runtime/bun"` (relative to carrot build output)
- **Carrot SDK view**: `import { createCarrotClient } from "./carrot-runtime/view"` (relative to carrot build output)
- **Carrot workers**: `import { BrowserWindow, Tray, app, ... } from "./carrot-runtime/bun"`
- **Shared types**: `import type { ... } from "../carrot-runtime/types"` (from ears src) or relative path in built carrots

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `BUNNY_EARS_BOOT_DEBUG` | Set to `"1"` for verbose boot logging |
| `BUNNY_EARS_CARROT_ROOT` | Override carrot install directory (default: `userData/carrots`) |
| `BUNNY_EARS_SDK_VIEW_MODULE` | Override path to SDK view module (for tests/dev) |
| `BUNNY_EARS_SDK_BUN_MODULE` | Override path to SDK bun module (for tests/dev) |
| `BUNNY_EARS_ZSTD_BIN` | Override path to zig-zstd binary (for tests) |
