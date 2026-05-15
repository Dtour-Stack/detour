#!/usr/bin/env bash
# Builds DetourPensieve.app — SwiftUI memory browser.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHARED="$HERE/../shared"
APP="$HERE/DetourPensieve.app"
BIN="$APP/Contents/MacOS/DetourPensieve"
RES="$APP/Contents/Resources"

if ! command -v swiftc >/dev/null 2>&1; then echo "swiftc not found." >&2; exit 1; fi

echo "[pensieve] building DetourPensieve.app at $APP"
rm -rf "$APP"
mkdir -p "$(dirname "$BIN")" "$RES"

swiftc -O \
	-target arm64-apple-macos13.0 \
	-framework AppKit -framework SwiftUI \
	-o "$BIN" \
	"$SHARED/WireTypes.swift" "$SHARED/DetourClient.swift" "$SHARED/CommonViews.swift" \
	"$HERE/main.swift"

cp "$HERE/Info.plist" "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"
if command -v codesign >/dev/null 2>&1; then
	codesign --force --sign - --deep "$APP" 2>/dev/null || echo "[pensieve] codesign skipped"
fi
echo "[pensieve] built $APP"
