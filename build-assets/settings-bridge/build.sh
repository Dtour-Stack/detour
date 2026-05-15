#!/usr/bin/env bash
# Builds DetourSettings.app — the SwiftUI Settings companion.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$HERE/DetourSettings.app"
BIN="$APP/Contents/MacOS/DetourSettings"
RES="$APP/Contents/Resources"

if ! command -v swiftc >/dev/null 2>&1; then
	echo "swiftc not found. Install Xcode CLT: xcode-select --install" >&2
	exit 1
fi

echo "[settings] building DetourSettings.app at $APP"

rm -rf "$APP"
mkdir -p "$(dirname "$BIN")" "$RES"

# SwiftUI requires macOS 13+ (Picker with native id binding etc).
swiftc \
	-O \
	-target arm64-apple-macos13.0 \
	-framework AppKit \
	-framework SwiftUI \
	-o "$BIN" \
	"$HERE/main.swift"

cp "$HERE/Info.plist" "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"

if command -v codesign >/dev/null 2>&1; then
	codesign --force --sign - --deep "$APP" 2>/dev/null || \
		echo "[settings] codesign failed (non-fatal)"
fi

echo "[settings] built $APP"
