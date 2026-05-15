#!/usr/bin/env bash
#
# Builds DetourBridge.app — the faceless Swift companion that gives
# Detour a working AppleScript surface.
#
# Output: build-assets/applescript-bridge/DetourBridge.app
#
# Run by scripts/post-build-applescript-bridge.ts during Detour's
# postBuild hook, OR directly for local development:
#
#     bash build-assets/applescript-bridge/build.sh
#
# Requires: swiftc (ships with Xcode Command Line Tools — `xcode-select
# --install` if missing). Pure swiftc, no Xcode project.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$HERE/DetourBridge.app"
BIN="$APP/Contents/MacOS/DetourBridge"
RES="$APP/Contents/Resources"

if ! command -v swiftc >/dev/null 2>&1; then
	echo "swiftc not found. Install Xcode Command Line Tools: xcode-select --install" >&2
	exit 1
fi

echo "[bridge] building DetourBridge.app at $APP"

rm -rf "$APP"
mkdir -p "$(dirname "$BIN")" "$RES"

# Compile the Swift binary. -framework Cocoa pulls in NSApplication +
# NSScriptCommand; -O optimizes (the bridge is tiny but we don't need
# debug symbols in production).
swiftc \
	-O \
	-framework Cocoa \
	-target arm64-apple-macos11.0 \
	-o "$BIN" \
	"$HERE/main.swift"

cp "$HERE/Info.plist" "$APP/Contents/Info.plist"
cp "$HERE/Detour.sdef" "$RES/Detour.sdef"

# PkgInfo — APPL???? marks the directory as an app bundle to
# LaunchServices. Strictly optional these days but cheap to include.
printf 'APPL????' > "$APP/Contents/PkgInfo"

# Ad-hoc codesign — required on Apple Silicon even for development
# bundles. Skip if codesign isn't available (e.g. CI without
# Developer ID setup); the unsigned bundle will still work for the
# user but with a Gatekeeper prompt on first launch.
if command -v codesign >/dev/null 2>&1; then
	codesign --force --sign - --deep "$APP" 2>/dev/null || \
		echo "[bridge] codesign failed (non-fatal) — bundle is unsigned"
fi

echo "[bridge] built $APP"
