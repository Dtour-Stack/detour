---
description: Rules for building Electrobun desktop apps with TypeScript and Bun
globs: "**/*.ts,**/*.tsx,**/*.html,**/*.css,electrobun.config.ts,package.json"
alwaysApply: false
---

# Electrobun App Ruleset

## Architecture

Electrobun apps run as Bun apps with two execution contexts:
- **Bun process (main)**: imports from `electrobun/bun` — manages windows, system APIs, lifecycle
- **Browser context (views)**: imports from `electrobun/view` — runs in webview, handles UI
- **Shared types**: RPC schemas defined in a shared location, imported by both contexts

IPC between bun and browser contexts uses postMessage, FFI, and (in some paths) encrypted WebSockets.

## Project Structure

```
my-app/
├── electrobun.config.ts    # App + build configuration
├── package.json            # Scripts: start, dev, build:canary, build:stable
├── tsconfig.json
├── src/
│   ├── bun/                # Main process code
│   │   └── index.ts        # Default bun entrypoint
│   ├── mainview/           # View code (one directory per view)
│   │   ├── index.ts        # View entrypoint
│   │   ├── index.html      # View HTML
│   │   └── index.css       # View styles
│   └── shared/             # Shared types (RPC schemas)
│       └── types.ts
├── scripts/                # Build hooks (preBuild, postBuild, etc.)
├── assets/                 # Static assets (icons, images)
├── build/                  # Build output (gitignored)
└── artifacts/              # Distribution artifacts (gitignored)
```

## Configuration (`electrobun.config.ts`)

Always use `satisfies ElectrobunConfig` for type safety:

```typescript
import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "My App",
    identifier: "com.example.myapp",
    version: "1.0.0",
  },
  runtime: {
    exitOnLastWindowClosed: true,
  },
  build: {
    bun: { entrypoint: "src/bun/index.ts" },
    views: {
      mainview: { entrypoint: "src/mainview/index.ts" },
    },
    copy: {
      "src/mainview/index.html": "views/mainview/index.html",
      "src/mainview/index.css": "views/mainview/index.css",
    },
  },
} satisfies ElectrobunConfig;
```

- `build.bun` and `build.views` accept all `Bun.build()` pass-through options (plugins, external, sourcemap, minify, define, etc.)
- `build.copy` maps source files to their destination under the bundled app's `Resources/app/` directory
- `runtime` keys are accessible at runtime via `BuildConfig.get()`
- `scripts` defines lifecycle hooks: `preBuild`, `postBuild`, `postWrap`, `postPackage`
- `release.baseUrl` is required for auto-updates

## Package Scripts

```json
{
  "scripts": {
    "start": "electrobun run",
    "dev": "electrobun dev",
    "dev:watch": "electrobun dev --watch",
    "build:dev": "bun install && electrobun build",
    "build:canary": "electrobun build --env=canary",
    "build:stable": "electrobun build --env=stable"
  }
}
```

## Typed RPC

Always define RPC schemas in a shared types file. Use `RPCSchema` for full type safety:

```typescript
// src/shared/types.ts
import type { RPCSchema } from "electrobun/bun";

export type MyRPC = {
  bun: RPCSchema<{
    requests: {
      getUser: { params: { id: string }; response: { name: string } };
    };
    messages: {
      logToBun: { msg: string };
    };
  }>;
  webview: RPCSchema<{
    requests: {
      updateUI: { params: { html: string }; response: boolean };
    };
    messages: {
      notify: { text: string };
    };
  }>;
};
```

**Rules for RPC:**
- Define schemas once in `src/shared/`, import in both bun and view contexts
- `requests` expect a response; `messages` are fire-and-forget
- Use `BrowserView.defineRPC<MyRPC>({ handlers })` on the bun side
- Use `Electroview.defineRPC<MyRPC>({ handlers })` on the view side
- Pass the RPC object to `BrowserWindow` via the `rpc` option
- `sandbox: true` disables RPC entirely — only use for untrusted content

## Security

Apply these defaults for any untrusted or third-party content:

```typescript
const win = new BrowserWindow({
  sandbox: true,                  // disables RPC
  partition: "persist:external",  // isolate storage
});

win.webview.setNavigationRules([
  "^*",                          // block everything by default
  "*://example.com/*",           // allow only trusted domains
  "^http://*",                   // enforce HTTPS
]);
```

**Security checklist:**
- Use `sandbox: true` for untrusted content
- Apply strict navigation allowlists via `setNavigationRules`
- Use separate `partition` values for isolation between accounts/contexts
- Validate all `host-message` payloads from `<electrobun-webview>` preload scripts
- Never write to `PATHS.RESOURCES_FOLDER` at runtime; use `Utils.paths.userData`
- Navigation rules: glob patterns, `^` prefix = block, last match wins, no match = allow

## Window and Webview Management

```typescript
import { BrowserWindow } from "electrobun/bun";

const win = new BrowserWindow({
  title: "My App",
  url: "views://mainview/index.html",
  frame: { width: 1200, height: 800 },
  titleBarStyle: "default",     // "default" | "hidden" | "hiddenInset"
  transparent: false,
  sandbox: false,
  partition: "persist:main",
  rpc: myRPC,
});
```

- Use `views://` protocol for bundled assets (works in URLs, HTML, CSS)
- Access default webview via `win.webview`
- Use `BrowserView.getById(id)` and `BrowserView.getAll()` for multi-view apps
- Webview methods: `loadURL`, `loadHTML`, `executeJavascript`, `openDevTools`, `findInPage`
- Window methods: `setTitle`, `close`, `focus`, `minimize`, `maximize`, `setFullScreen`, `setAlwaysOnTop`, `setFrame`

**`<electrobun-webview>` tag** for process-isolated nested webviews:
```html
<electrobun-webview
  id="child-webview"
  src="https://example.com"
  partition="persist:isolated"
  sandbox
></electrobun-webview>
```

## Events and Lifecycle

Use `before-quit` for async shutdown cleanup — never rely on `process.on("exit")` for async work:

```typescript
import Electrobun from "electrobun/bun";

Electrobun.events.on("before-quit", async (e) => {
  await saveState();
  // e.response = { allow: false }; // cancel quit
});
```

**Important events:**
- `before-quit` — cleanup, optional quit cancellation
- `open-url` — deep links and file associations (macOS)
- `will-navigate` — navigation events (informational; allow/block decided by rules)
- `application-menu-clicked` — custom menu actions
- `context-menu-clicked` — custom context menu actions

**Linux caveat:** system-initiated quit paths (Ctrl+C, window-manager, taskbar) may not fire `before-quit`. Programmatic quit via `Utils.quit()` / `process.exit()` is reliable.

## Platform APIs

### Menus
- Use role-based items (`quit`, `undo`, `redo`, `cut`, `copy`, `paste`, `delete`, `selectAll`) for native shortcuts
- `ApplicationMenu.setApplicationMenu(...)` for the app menu bar
- `ContextMenu.showContextMenu(...)` for right-click menus

### System Tray
- Set `runtime.exitOnLastWindowClosed: false` for tray-only apps
- Use template images on macOS (`template: true`)
- Handle `tray-clicked` and `tray-item-clicked` events

### Updater
```typescript
import { Updater } from "electrobun/bun";

const update = await Updater.checkForUpdate();
if (update.updateAvailable) {
  await Updater.downloadUpdate();
}
if (Updater.updateInfo()?.updateReady) {
  await Updater.applyUpdate();
}
```
- Keep `release.baseUrl` aligned with uploaded artifacts
- Patches attempt incremental first, fall back to full bundle

### Utils
- `Utils.paths.userData` / `userCache` / `userLogs` for persistence
- `Utils.openExternal`, `Utils.openPath` for external resources
- `Utils.showMessageBox`, `Utils.showNotification` for user interaction
- `Utils.openFileDialog` for file selection
- `Utils.clipboardReadText`, `Utils.clipboardWriteText` for clipboard
- `Utils.moveToTrash`, `Utils.showItemInFolder` for file operations

### Other APIs
- `GlobalShortcut` — system-wide keyboard shortcuts
- `Screen` — display info and cursor position
- `Session` — cookie and storage management per partition

## Build and Distribution

### Build lifecycle hooks (execution order):
1. `preBuild`
2. `postBuild`
3. `postWrap`
4. `postPackage`

Available env vars in hooks: `ELECTROBUN_BUILD_ENV`, `ELECTROBUN_OS`, `ELECTROBUN_ARCH`, `ELECTROBUN_BUILD_DIR`, `ELECTROBUN_APP_NAME`, `ELECTROBUN_APP_VERSION`, `ELECTROBUN_APP_IDENTIFIER`, `ELECTROBUN_ARTIFACT_DIR`

### Artifacts (non-dev builds):
- `{channel}-{os}-{arch}-update.json`
- Platform installers (DMG on macOS)
- `.tar.zst` update bundle
- `.patch` incremental patch

### Platform-specific config:
- **macOS**: `codesign`, `notarize`, `createDmg`, `bundleCEF`, `bundleWGPU`, `defaultRenderer`, `entitlements`, `icons` (.iconset or .icon)
- **Windows**: `bundleCEF`, `bundleWGPU`, `defaultRenderer`, `icon` (.ico)
- **Linux**: `bundleCEF`, `bundleWGPU`, `defaultRenderer`, `icon` (.png)

### Renderer guidance:
- `bundleCEF: true` + `defaultRenderer: "cef"` for Chromium consistency across platforms
- Native renderers (WebKit/WebView2/GTKWebKit) are the default

## Testing

Electrobun apps are tested using a custom integration test framework (see `kitchen/` for the reference implementation). Tests run in the live Electrobun runtime — they create real `BrowserWindow` instances, exercise RPC, and verify native behavior.

### Test Framework Architecture

```
src/
├── test-framework/
│   ├── types.ts          # TestDefinition, TestContext, expect(), defineTest()
│   └── executor.ts       # TestExecutor singleton — runs tests, manages windows
├── test-harness/
│   ├── index.ts          # Bundled view for RPC testing (echo, add, multiply, etc.)
│   └── index.html
├── test-runner/
│   ├── index.ts          # Test runner UI (Electroview RPC client)
│   ├── index.html
│   ├── index.css
│   └── rpc.ts            # TestRunnerRPC schema
└── tests/
    ├── index.ts          # Aggregates all test arrays → allTests
    ├── rpc.test.ts       # Automated RPC tests
    ├── window.test.ts    # Automated window tests
    ├── events.test.ts    # Automated event tests
    ├── navigation.test.ts
    ├── sandbox.test.ts
    ├── session.test.ts
    ├── ...               # More automated test files
    └── interactive/      # Interactive tests (require user verification)
        ├── dialogs.test.ts
        ├── tray.test.ts
        ├── menus.test.ts
        └── ...
```

### Test Definition

Every test uses `defineTest()` from `test-framework/types.ts`:

```typescript
import { defineTest, expect } from "../test-framework/types";

export const myTests = [
  defineTest({
    name: "descriptive test name",
    category: "CategoryName",       // groups tests in the UI
    description: "What this test verifies",
    interactive: false,             // true = requires user verification
    timeout: 15000,                 // default: 10000ms
    async run({ createWindow, log }) {
      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "My Test Window",
        renderer: "cef",            // "cef" or "native"
      });

      await new Promise((resolve) => setTimeout(resolve, 1000));

      const result = await win.webview.rpc?.request.multiply({ a: 6, b: 7 });
      expect(result).toBe(42);
      log(`Got result: ${result}`);
    },
  }),
];
```

### TestContext API

The `run` function receives a `TestContext` with:

- **`createWindow(options)`** — Creates a real `BrowserWindow`. Returns `{ id, webviewId, window, webview, close }`. Options: `url`, `html`, `preload`, `rpc`, `width`, `height`, `x`, `y`, `title`, `titleBarStyle`, `trafficLightOffset`, `renderer` (`"cef"` | `"native"`), `hidden`, `activate`, `sandbox`.
- **`log(message)`** — Logs to both terminal and test runner UI.
- **`showInstructions(instructions)`** — (Interactive) Shows instructions, waits for user to click "Start".
- **`waitForUserVerification()`** — (Interactive) Waits for user to click Pass/Fail/Re-test.
- **`waitForUserAction(instructions)`** — (Legacy interactive) Combines show + verify.

### Assertions

Use the custom `expect()` from the test framework (not `bun:test`):

```typescript
expect(value).toBe(expected);
expect(value).toEqual(expected);
expect(value).toBeGreaterThan(n);
expect(value).toBeGreaterThanOrEqual(n);
expect(value).toBeLessThan(n);
expect(value).toBeLessThanOrEqual(n);
expect(value).toBeTruthy();
expect(value).toBeFalsy();
expect(value).toBeNull();
expect(value).toBeUndefined();
expect(value).toBeDefined();
expect(value).toContain(item);       // strings and arrays
expect(value).toHaveLength(n);       // strings and arrays
expect(value).toBeInstanceOf(Class);
expect(value).toMatch(/regex/);
expect(fn).toThrow();
```

### Test Harness

The test harness (`src/test-harness/`) is a bundled view that provides standard RPC handlers for tests:

```typescript
// Webview-side handlers (test-harness/index.ts):
requests: {
  getDocumentTitle: () => document.title,
  multiply: ({ a, b }) => a * b,
  getElementText: ({ selector }) => document.querySelector(selector)?.textContent || null,
  setBodyContent: ({ html }) => { document.body.innerHTML = html; },
}

// Bun-side handlers (defined per-test or shared):
requests: {
  echo: ({ value }) => value,
  add: ({ a, b }) => a + b,
  throwError: ({ message }) => { throw new Error(message); },
  delayed: async ({ ms, value }) => { await sleep(ms); return value; },
}
```

### Test Runner UI

The test runner (`src/test-runner/`) is an Electroview-based UI that:
- Lists all tests grouped by category with status icons (○ pending, ◎ running, ✓ passed, ✗ failed)
- Provides "Run All Automated" and "Run Interactive Tests" buttons
- Shows interactive test modals with Pass/Fail/Re-test controls
- Displays build config (renderer, Chromium version, Bun version, user agent)
- Shows updater status banner with history panel
- Supports fuzzy search across test name, category, and description
- Persists search query to `userData/test-runner-preferences.json`

### Bun Entrypoint Setup

```typescript
// src/bun/index.ts
import { executor } from "../test-framework/executor";
import { allTests } from "../tests";
import type { TestRunnerRPC } from "../test-runner/rpc";

// 1. Register all tests
executor.registerTests(allTests);

// 2. Define RPC for the test runner window
const testRunnerRPC = BrowserView.defineRPC<TestRunnerRPC>({
  maxRequestTime: 300000,
  handlers: {
    requests: {
      getTests: () => executor.getTests().map(t => ({ id, name, category, description, interactive })),
      runTest: ({ testId }) => executor.runTest(test),
      runAllAutomated: () => executor.runAllAutomated(),
      runInteractiveTests: () => executor.runInteractiveTests(),
      submitReady: ({ testId }) => executor.submitReady(testId),
      submitVerification: ({ testId, action, notes }) => executor.submitVerification(testId, action, notes),
      // ... preferences, updater, etc.
    },
  },
});

// 3. Create the test runner window
const testRunnerWindow = new BrowserWindow({
  title: "Integration Tests",
  url: "views://test-runner/index.html",
  renderer: "cef",
  rpc: testRunnerRPC,
});

// 4. Wire up application menu for keyboard shortcuts
ApplicationMenu.setApplicationMenu([
  { submenu: [{ label: "Quit", role: "quit", accelerator: "q" }] },
  { label: "Edit", submenu: [ { role: "undo" }, { role: "redo" }, ... ] },
  { label: "Tests", submenu: [
    { label: "Run All Automated", action: "run-all-automated", accelerator: "CommandOrControl+R" },
    { label: "Run Interactive Tests", action: "run-interactive", accelerator: "CommandOrControl+Shift+R" },
  ]},
]);

Electrobun.events.on("application-menu-clicked", async (e) => {
  if (e.data.action === "run-all-automated") await executor.runAllAutomated();
});
```

### Test Execution Rules

- **Automated tests** run sequentially within each category to avoid resource exhaustion (30+ CEF instances in parallel crash on Linux)
- **Interactive tests** run one at a time, pausing for user verification
- **Window cleanup**: `TestExecutor` tracks all windows created per test and closes them in `finally` — with a 200ms delay between tests to let CEF/WebKit finish async cleanup
- **Timeouts**: Default 10s per test, configurable via `timeout` option. Long-running tests (large payloads, fullscreen toggles) use 15-30s
- **Platform-specific tests**: Guard with `if (process.platform !== "darwin") { log("Skipping..."); return; }`
- **Renderer selection**: Default to `"cef"` for consistency. Use `"native"` for renderer-specific tests
- **Environment variables for CI**:
  - `AUTO_RUN_TEST_NAME` / `AUTO_RUN_WGPU` / `AUTO_ACCEPT_INTERACTIVE` — skip interactive prompts
  - `BUNNY_EARS_SDK_VIEW_MODULE` / `BUNNY_EARS_SDK_BUN_MODULE` — override SDK paths (for bunny tests)
  - `BUNNY_EARS_ZSTD_BIN` — override zig-zstd binary path

### Adding a New Test

1. Create `src/tests/<feature>.test.ts` (or `src/tests/interactive/<feature>.test.ts` for interactive)
2. Export a `TestDefinition[]` array
3. Import and spread it in `src/tests/index.ts`
4. The test runner UI auto-discovers it via `executor.getTests()`

### Test Categories

Use these standard categories for consistency:
- `RPC` — Bidirectional request/response and messaging
- `BrowserWindow` — Window creation, sizing, positioning, state
- `BrowserView` — Webview management, getAll, getById
- `Navigation` — loadURL, loadHTML, navigation rules, dom-ready, did-navigate
- `Events` — Global and per-window events, handler registration
- `Sandbox` — Sandbox mode (RPC disabled, events still work, OOPIF blocked)
- `Session` — Partition management, cookies API
- `Screen` — Display info, cursor position
- `Utils` — File dialogs, clipboard, notifications, paths
- `Preload` — Preload script injection
- `Updater` — Update checking, downloading, applying
- `Tray` — System tray creation and menus
- `WGPU` — WebGPU adapter, FFI, rendering
- `Interactive` — User-verified tests (dialogs, shortcuts, menus, etc.)

### Config for Test Views

In `electrobun.config.ts`, register test views:

```typescript
build: {
  views: {
    "test-runner": { entrypoint: "src/test-runner/index.ts", minify: true },
    "test-harness": { entrypoint: "src/test-harness/index.ts" },
  },
  copy: {
    "src/test-runner/index.html": "views/test-runner/index.html",
    "src/test-runner/index.css": "views/test-runner/index.css",
    "src/test-harness/index.html": "views/test-harness/index.html",
  },
}
```

## Common Patterns

- **Keyboard shortcuts**: define an Edit `ApplicationMenu` with role-based items
- **Tray-only app**: set `runtime.exitOnLastWindowClosed: false`, drive UX from `Tray`
- **Multi-account isolation**: use separate `partition` values per account, manage via `Session.fromPartition(...)`
- **Chromium consistency**: set `bundleCEF: true` and `defaultRenderer: "cef"` in platform config
- **Runtime config access**: `import { BuildConfig } from "electrobun/bun"` then `await BuildConfig.get()`

## Imports

- Main process: `import { BrowserWindow, BrowserView, ... } from "electrobun/bun"`
- View context: `import { Electroview } from "electrobun/view"`
- Shared types: `import type { RPCSchema } from "electrobun/bun"`
- Config: `import type { ElectrobunConfig } from "electrobun"`

## Electrobun vs Electron: Key Differences

**Electrobun is NOT Electron.** Different architecture, different APIs. Do not use Electron patterns.

### Architectural Differences

| Concept | Electron | Electrobun |
|---------|----------|------------|
| **Runtime** | Node.js + V8 | Bun (JavaScriptCore) |
| **Main process** | Node.js main thread | Bun worker thread (main thread runs native event loop via FFI) |
| **Renderer** | Always Chromium (~150MB) | System WebView by default (WebKit/WebView2/GTKWebKit); optional CEF |
| **IPC** | `ipcMain` / `ipcRenderer` | Typed RPC via `BrowserView.defineRPC()` / `Electroview.defineRPC()` |
| **Preload** | `preload.js` with `contextBridge` | `preload` option on BrowserWindow/BrowserView |
| **Webview tag** | Chrome's deprecated `<webview>` | Custom `<electrobun-webview>` (separate native layer, not in-process) |
| **Bundle size** | 150MB+ | ~14MB compressed |
| **Startup** | 2-5s | <50ms |
| **Updates** | Full binary replacement (100MB+) | BSDIFF patches (as small as 14KB) |
| **Distribution** | ASAR archives | ZSTD self-extracting bundles |
| **Config** | `electron-builder` / `forge` | Single `electrobun.config.ts` |
| **Dev server** | `electron .` | `electrobun dev` (Bun-based CLI) |

### APIs That Don't Exist in Electrobun

Do NOT use these Electron APIs — they have no equivalent:

- `ipcMain` / `ipcRenderer` — use typed RPC instead
- `remote` module — removed in Electron 14, never existed in Electrobun
- `webContents` — use `BrowserView` methods directly
- `BrowserWindow.webContents` — use `win.webview` (a `BrowserView` instance)
- `app.whenReady()` — Electrobun starts immediately; use top-level code
- `nativeTheme` — no equivalent
- `powerMonitor` — no equivalent
- `autoUpdater` — use `Updater` from `electrobun/bun`
- `protocol.register*Protocol` — use `views://` scheme for bundled assets
- `shell.openExternal` — use `Utils.openPath`

### APIs That Work Differently

- **`BrowserWindow`**: Constructor takes `url` or `html` directly (no `loadURL` needed for initial load). The `webview` property is a `BrowserView`, not `webContents`.
- **`BrowserView`**: In Electrobun this is the webview handle. Created automatically by `BrowserWindow` or manually for advanced cases. Use `BrowserView.getAll()` / `BrowserView.getById(id)` to enumerate.
- **Events**: Use `Electrobun.events.on("event-name", handler)` for global events, `win.window.on("event-name", handler)` for window events, `win.webview.on("event-name", handler)` for webview events. No `ipcMain.on`.
- **RPC**: Fully typed. Define schemas with `RPCSchema<>`, create with `BrowserView.defineRPC()` (bun side) and `Electroview.defineRPC()` (view side). Bun handlers go in `handlers.requests`, view handlers go in `handlers.requests`. Messages (fire-and-forget) go in `handlers.messages`.
- **`views://` scheme**: Use `views://viewname/index.html` to load bundled views. This replaces Electron's `protocol.registerFileProtocol` + `file://` paths.
- **`partition`**: Set on `BrowserWindow` options directly (not via `webPreferences`). Use `Session.fromPartition(name)` to manage cookies/storage per partition.
- **`sandbox`**: Set on `BrowserWindow` options directly. Disables RPC entirely — events still work. Use for untrusted content.
- **`titleBarStyle`**: `"default"`, `"hiddenInset"`, or `"hidden"` — set directly on `BrowserWindow` options.
- **Application menu**: Use `ApplicationMenu.setApplicationMenu(items)` — not `Menu.buildFromTemplate`. Menu items use `action` strings (not `click` functions). Listen via `Electrobun.events.on("application-menu-clicked", ...)`.
- **Context menu**: Use `ContextMenu.showContextMenu(items)` — not `Menu.popup`. Listen via `Electrobun.events.on("context-menu-clicked", ...)`.
- **Tray**: `new Tray({ title, icon?, tooltip? })` then `tray.setMenu(items)`. Events: `"tray-clicked"`.
- **Global shortcuts**: `GlobalShortcut.register(accelerator, callback)` — not `globalShortcut.register`.
- **File dialogs**: `Utils.openFileDialog(opts)` returns `{ filePaths, bookmarks? }` — not `dialog.showOpenDialog`.
- **Message boxes**: `Utils.showMessageBox(opts)` returns `{ response }` — not `dialog.showMessageBox`.
- **Notifications**: `Utils.showNotification(opts)` — not `new Notification()`.
- **Clipboard**: `Utils.clipboardReadText()`, `Utils.clipboardWriteText(text)`, `Utils.clipboardReadImage()`, `Utils.clipboardWriteImage(pngData)`, `Utils.clipboardClear()`.
- **Quit**: Use `Utils.quit()` for graceful shutdown with CEF cleanup — not `app.quit()` or `process.exit()`.
- **Updater**: `Updater.checkForUpdate()`, `Updater.downloadUpdate()`, `Updater.applyUpdate()`, `Updater.onStatusChange(handler)`. Uses `release.baseUrl` from config.

## Anti-Patterns and Don'ts

### Don't Use Node.js APIs Unnecessarily

Electrobun runs on Bun, not Node.js. While Bun implements most Node.js APIs, prefer Bun-native APIs when available. Avoid Node.js-specific packages that depend on V8 internals or native Node addons.

### Don't Call RPC Before Webview Is Ready

```typescript
// ❌ WRONG: RPC may not be ready yet
const win = new BrowserWindow({ url: "views://mainview/index.html", rpc });
const result = await win.webview.rpc?.request.someMethod({}); // may fail

// ✅ CORRECT: Wait for dom-ready
const win = new BrowserWindow({ url: "views://mainview/index.html", rpc });
win.webview.on("dom-ready", async () => {
  const result = await win.webview.rpc?.request.someMethod({});
});
```

### Don't Use `process.exit()` for Shutdown

```typescript
// ❌ WRONG: Bypasses CEF cleanup, may crash or leak resources
process.exit(0);

// ✅ CORRECT: Graceful shutdown with native cleanup
import { Utils } from "electrobun/bun";
Utils.quit();
```

### Don't Create Too Many Windows in Parallel

```typescript
// ❌ WRONG: 30+ CEF instances in parallel crash on Linux
await Promise.all(tests.map(test => createWindowAndRun(test)));

// ✅ CORRECT: Run sequentially within categories
for (const test of tests) {
  await createWindowAndRun(test);
}
```

### Don't Mix `sandbox: true` with RPC

```typescript
// ❌ WRONG: RPC is disabled in sandbox mode — calls will timeout
const win = new BrowserWindow({ sandbox: true, rpc: myRpc });
await win.webview.rpc?.request.someMethod({}); // never resolves

// ✅ CORRECT: Sandbox is for untrusted content without RPC
const win = new BrowserWindow({ sandbox: true }); // events still work
win.webview.on("dom-ready", () => { /* observe only */ });
```

### Don't Use Electron's `webview` Tag

Electrobun has its own `<electrobun-webview>` custom element. It's a separate native layer (not in-process like Electron's). This means:
- Normal DOM stacking (`z-index`) doesn't work over it — use **mask selectors** to punch holes
- It's a positional anchor div + a separate BrowserView overlaid at the same coordinates
- Passthrough/mask behavior not supported on Linux with transparent windows
- Passthrough/mask behavior not supported on Windows with WebView2 — enable `bundleCEF: true`

### Don't Forget the Edit Menu

Keyboard shortcuts like `Cmd+C`, `Cmd+V`, `Cmd+A` don't work automatically. You must define an Edit menu:

```typescript
ApplicationMenu.setApplicationMenu([
  { label: "Edit", submenu: [
    { role: "undo" }, { role: "redo" }, { type: "separator" },
    { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
  ]},
]);
```

### Don't Hardcode Paths for Bundled Assets

```typescript
// ❌ WRONG: Won't work in production builds
win.webview.loadURL("file://" + join(__dirname, "views/mainview/index.html"));

// ✅ CORRECT: Use views:// scheme
const win = new BrowserWindow({ url: "views://mainview/index.html" });
```

### Don't Use `as any` for RPC Types

```typescript
// ❌ WRONG: Loses all type safety
const result = await (win.webview.rpc as any).request.someMethod({});

// ✅ CORRECT: Define a shared RPC schema type
export type MyRPC = {
  bun: RPCSchema<{ requests: { someMethod: { params: {...}; response: ... } } }>;
  webview: RPCSchema<{ requests: { ... } }>;
};
const rpc = BrowserView.defineRPC<MyRPC>({ handlers: { ... } });
```

### Don't Skip the `release.baseUrl`

Without `release.baseUrl` in `electrobun.config.ts`, the updater can't find updates. This must point to the root URL where your `artifacts/` folder contents are hosted.

### Don't Use `bun build` Directly

Electrobun has its own build pipeline via `electrobun dev` / `electrobun build`. Don't invoke `bun build` manually — the CLI handles bundling, native binary inclusion, code signing, notarization, and artifact generation.

## Troubleshooting Quick Reference

| Symptom | Likely Cause |
|---------|-------------|
| RPC calls fail | Target webview is sandboxed (`sandbox: true` disables RPC) |
| RPC type errors | Shared RPC types don't match between bun and browser handlers |
| Navigation blocked | `setNavigationRules` ordering — last match wins |
| Updater says no update | `release.baseUrl` mismatch or artifact naming wrong |
| User sessions leak | Missing per-account `partition` values |
| Build hooks not running | Hook path incorrect or not executable via Bun |
| `before-quit` not firing (Linux) | System-initiated quit — use programmatic quit instead |
| Keyboard shortcuts don't work | Missing Edit `ApplicationMenu` with role-based items |
| Webview tag overlays broken on Windows | WebView2 doesn't support passthrough — enable `bundleCEF: true` |
| Webview tag overlays broken on Linux | Transparent CEF windows don't support passthrough — use non-transparent window |
