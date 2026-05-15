#!/usr/bin/env bash
# Build Swiftun — the (future) Detour shell.
# Scaffold pipeline. The end-state script will also:
#   - copy the Bun binary to Resources/bin/bun
#   - copy bun output (index.js) + views into Resources/app/
#   - codesign + notarize
# For now: compile the Swift package and report the executable path.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v swift >/dev/null 2>&1; then
	echo "swift not found. Install Xcode CLT: xcode-select --install" >&2
	exit 1
fi

cd "$HERE"
echo "[swiftun] building (swift build -c release)"
swift build -c release

BIN="$HERE/.build/release/Swiftun"
if [ ! -x "$BIN" ]; then
	echo "[swiftun] expected $BIN, didn't appear" >&2
	exit 1
fi

echo "[swiftun] built $BIN"
echo ""
echo "Run with:"
echo "  DETOUR_BUN_PATH=\$(which bun) \\"
echo "  DETOUR_BUN_ENTRY=\$(pwd)/../../src/bun/index.ts \\"
echo "  $BIN"
echo ""
echo "Or after \`bun run build:dev\` produced a Detour.app bundle:"
echo "  Swiftun.app/Contents/Resources/app/bun/index.js will be picked"
echo "  up automatically by BunProcess."
