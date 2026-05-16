# apps/legacy-electrobun — The pre-consolidation Electrobun app

The original Detour build: a single Electrobun bundle containing the bun
runtime + a React app rendered into WKWebViews. **No longer the shipping
artifact.** Kept buildable for backward-compat and so users with the old
detour:// URL associations still get something.

## Where the code lives

| Concern | Path |
|---|---|
| Electrobun config | `electrobun.config.ts` |
| React entrypoint | `src/main/index.tsx` |
| View HTML shells | `src/main/{index,activity,pensieve,browser,pet,...}.html` |
| Build target | `build/{dev,canary,stable}-macos-arm64/Detour-{dev,canary,}.app` |

## Build

```sh
bun run build:dev       # local dev build
bun run build:canary    # rolling main builds
bun run build:stable    # tagged release
```

These still work, but the resulting `.app` is **not** the same as
`dist/Detour.app` (which is the new native Mac app).

## Why it's legacy

- Tray + every window has been re-implemented as native SwiftUI in
  `apps/mac/` (Swiftun).
- WKWebView + React surfaces (the previous default) added ~80MB of payload
  and a second runtime to maintain.
- WKWebView's stripped UA broke things like Phantom Connect (needs CEF or
  a real Chrome UA) — the native app uses CEF only where actually needed.
- The unified `~/.detour/rpc.sock` JSON-RPC IPC replaced electrobun's
  built-in typed-RPC over postMessage.

## Status

- `electrobun.config.ts` still drives this path
- `scripts/post-build-*` chain still compiles the per-window companion
  `.app` bundles (`DetourSettings.app`, `DetourPensieve.app`, etc.) that
  the legacy app embedded
- None of these are consumed by `apps/mac/` anymore

If/when no one needs the legacy build, the cleanup is: delete `src/main/`,
the post-build companion-app builders, and the electrobun-specific
`build-assets/`.
