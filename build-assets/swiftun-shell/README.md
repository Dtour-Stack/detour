# Swiftun — the eventual Electrobun replacement on Mac

**Status:** scaffold. The goal is a native Swift shell that owns
the Detour macOS app outright — one process, one bundle, no
companion `.app` files inside Resources.

## Why

Today Detour ships as an Electrobun bundle plus four embedded Swift
companions (DetourBridge, DetourTray, DetourSettings, DetourActivity,
DetourPensieve). That works, but it means:
- Five processes per running Detour (Electrobun launcher + Bun + the
  Swift companions that happen to be open).
- AppleScript dispatches to `ai.detour.bridge` instead of `ai.detour.app`
  because Electrobun's launcher has no Cocoa scripting hook.
- Five bundle IDs in Activity Monitor.
- WKWebView config is dictated by Electrobun.

Swiftun rolls all of this into one native Swift binary that:
1. Spawns Bun as a child process (the agent core).
2. Hosts a single `NSApplication` that owns the tray, AppleScript
   dictionary, settings window, activity window, pensieve window,
   chat window — every UI surface, no separate bundles.
3. Embeds a `WKWebView` for whatever React surfaces haven't been
   ported to SwiftUI yet (currently Chat, Workspace, Browser, etc.).
4. As more SwiftUI views land, the WKWebView surface shrinks.

End state: one `Detour.app`, one process tree (Swift main + Bun child),
zero embedded companions.

## Layout

```
build-assets/swiftun-shell/
├── README.md                       (this file)
├── Package.swift                   (Swift Package, top-level)
├── Sources/Swiftun/
│   ├── main.swift                  app entry, NSApplication boot
│   ├── BunProcess.swift            spawn + supervise Bun subprocess
│   ├── ShellWindow.swift           main window with embedded WKWebView
│   ├── TrayController.swift        (reuses tray-bridge logic, in-process)
│   ├── AppleScriptDispatch.swift   (reuses applescript-bridge logic)
│   ├── SettingsWindow.swift        (reuses settings-bridge views)
│   ├── ActivityWindow.swift        (reuses activity-bridge views)
│   ├── PensieveWindow.swift        (reuses pensieve-bridge views)
│   └── URLSchemeHandler.swift      (handles open-url at NSApp level)
└── build.sh                        (compile, codesign, bundle)
```

## What the shell does NOT replace

- **Bun core** (`src/bun/`, `eliza/`, `src/shared/`, every plugin) —
  unchanged, runs as a child process the same way Electrobun spawns it.
- **React views** (`src/main/`) — still rendered inside a WKWebView
  for surfaces that haven't been ported to SwiftUI. The shell points
  the WebView at the same `views://` (or `http://127.0.0.1:2138/...`)
  paths.

## Migration plan

1. **Scaffold** (this directory) — the structure, a working
   `main.swift` that spawns Bun, hosts a single window with WKWebView,
   prints "Hello from Swiftun." This is the milestone right after
   this commit.
2. **Tray** — port `tray-bridge/main.swift` into the shell. One
   `NSStatusItem` owned by the shell, not a separate process.
3. **AppleScript** — same: port `applescript-bridge/main.swift` into
   the shell so `tell application "Detour"` works at `ai.detour.app`.
4. **Settings / Activity / Pensieve windows** — port the SwiftUI
   views into the shell. They become `NSWindow` instances owned by
   the shell process. Companion .app bundles get deleted.
5. **Build pipeline** — `swift build` or `xcodebuild` produces
   Detour.app directly. Replace `electrobun build` in package.json.
6. **Auto-updater** — wire in Sparkle.
7. **Cut over Mac → Swiftun.** Electrobun stays for Windows + Linux
   (or also gets replaced with native shells; that's a later call).

## Why a scaffold first, not a full port?

The shell is ~2,500-3,500 lines of Swift to do everything Electrobun
does for us today. Building it incrementally means the React surfaces
keep working while we migrate piece by piece. Scaffolding first means
the next commit is one focused step (e.g. "make Bun spawn work")
instead of "rewrite the entire shell."

## Not built yet

- The compile pipeline (`build.sh`) — needs to handle Bun binary
  copying + codesigning + Info.plist generation.
- Window state restoration (Electrobun gives this for free).
- Auto-updater (use Sparkle when we get there).
- Custom `views://` scheme handler (Electrobun has one; we'd write
  `WKURLSchemeHandler` to replicate).
- Phantom Connect — needs CEF or a workaround since WKWebView's UA
  drops the `Safari/` suffix that Phantom checks. The current
  Electrobun build bundles CEF for this; Swiftun would need to
  either bundle CEF ourselves or move Phantom out of the in-app
  browser.
