# apps/mac — The native macOS app

The Detour Mac app. Native Swift (Swiftun) binary that hosts the tray + every
window, spawns the bundled bun runtime as a subprocess, and talks to it over
two Unix domain sockets.

## Where the code lives

| Concern | Path |
|---|---|
| Swift binary entrypoint | `build-assets/swiftun-shell/Sources/Swiftun/main.swift` |
| Swift Package | `build-assets/swiftun-shell/Package.swift` |
| Tray + AppleScript + windows | `build-assets/swiftun-shell/Sources/Swiftun/{Tray,AppleScript,*Surface}.swift` |
| App build script | `scripts/build-mac-app.ts` |
| Build output | `dist/Detour.app` |

The code is still under `build-assets/swiftun-shell/` (historical) — this
`apps/mac/` directory is a signpost during the incremental cutover.

## Building

```sh
bun run build:agent   # produces dist-agent/  (the bundled bun runtime + assets)
bun run build:mac     # produces dist/Detour.app  (consumes dist-agent/)
open dist/Detour.app
```

The Mac app no longer depends on electrobun. `bun run build:agent` produces
just the bun bundle + asset payload the Mac app needs; nothing React or
WKWebView-flavored.

## What ships in the .app

```
Detour.app/
├── Contents/
│   ├── MacOS/
│   │   ├── Detour            ← Swiftun binary
│   │   ├── bun               ← bundled bun runtime
│   │   └── mlx.metallib      ← MLX Metal shader bundle
│   ├── Info.plist            ← privacy entitlements (Speech, Mic, Vision)
│   └── Resources/
│       ├── AppIcon.png
│       ├── Detour.sdef       ← AppleScript dictionary
│       └── app/              ← bun runtime payload (eliza, plugins, knowledge)
```

## IPC

Two Unix sockets between Swift and bun:

- `~/.detour/rpc.sock` — bun-server, Swift-client. UI events + tray state.
- `~/.detour/mlx.sock` — Swift-server, bun-client. MLX/Apple-framework work
  (STT, TTS, Vision, image gen). Isolated so MLX inference can't hang the UI.

Both speak newline-delimited JSON-RPC 2.0.

## What's been native-ified (no React)

- Tray menu (`TrayController.swift`)
- Settings (`SettingsSurface.swift`)
- Pensieve memory/search (`PensieveSurface.swift`)
- Activity / trajectories (`ActivitySurface.swift`)
- Chat (`ChatSurface.swift`)
- Browser (`BrowserSurface.swift`)
- Gallery (`GallerySurface.swift`)
- Workspace (`WorkspaceSurface.swift`)
- Knowledge (`KnowledgeSurface.swift`)
- Pet (`PetSurface.swift`)

## What's still WKWebView

A couple of surfaces still use WKWebView with a small Electrobun-shim
preload (e.g. wallet's Phantom Connect — that one has to be WKWebView because
Phantom Portal needs a specific page origin). These are documented in the
Swift source as exceptions, not the default.
