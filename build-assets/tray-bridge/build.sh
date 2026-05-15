#!/usr/bin/env bash
#
# Builds DetourTray.app — the Swift tray companion that owns the
# menu-bar NSStatusItem with a rich native NSMenu.
#
# Output: build-assets/tray-bridge/DetourTray.app
#
# Run by scripts/post-build-tray-bridge.ts during Detour's postBuild
# hook, OR directly for local dev: `bash build-assets/tray-bridge/build.sh`.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$HERE/DetourTray.app"
BIN="$APP/Contents/MacOS/DetourTray"
RES="$APP/Contents/Resources"

if ! command -v swiftc >/dev/null 2>&1; then
	echo "swiftc not found. Install Xcode CLT: xcode-select --install" >&2
	exit 1
fi

echo "[tray] building DetourTray.app at $APP"

rm -rf "$APP"
mkdir -p "$(dirname "$BIN")" "$RES"

swiftc \
	-O \
	-framework Cocoa \
	-target arm64-apple-macos11.0 \
	-o "$BIN" \
	"$HERE/main.swift"

cp "$HERE/Info.plist" "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"

if command -v codesign >/dev/null 2>&1; then
	codesign --force --sign - --deep "$APP" 2>/dev/null || \
		echo "[tray] codesign failed (non-fatal)"
fi

echo "[tray] built $APP"
