#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHARED="$HERE/../shared"
APP="$HERE/DetourBrowser.app"
BIN="$APP/Contents/MacOS/DetourBrowser"

if ! command -v swiftc >/dev/null 2>&1; then echo "swiftc not found" >&2; exit 1; fi

echo "[browser] building $APP"
rm -rf "$APP"
mkdir -p "$(dirname "$BIN")" "$APP/Contents/Resources"

swiftc -O   -target arm64-apple-macos13.0   -framework AppKit -framework WebKit   -o "$BIN"   "$SHARED/ReactSurface.swift"   "$SHARED/WebViewCompanion.swift"   "$HERE/main.swift"

cp "$HERE/Info.plist" "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"
if command -v codesign >/dev/null 2>&1; then
  codesign --force --sign - --deep "$APP" 2>/dev/null || echo "[browser] codesign skipped"
fi
echo "[browser] built $APP"
