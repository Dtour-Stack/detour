#!/bin/bash
# Re-publish the Detour UI bundle to Vercel at phantom.detour.ninja so it
# stays in sync with whatever's currently in the build dir. Run after any
# UI change (electrobun dev/build). Phantom's OAuth redirect lands here,
# Detour's WKWebView also loads from here (via DETOUR_DEV_URL in .env).
#
# Usage:
#   bash scripts/redeploy-phantom-redirect.sh
#
# Pre-reqs (one-time):
#   1. `vercel login`
#   2. First-run only: `cd build/vercel-phantom-redirect && vercel link`
#      then in the Vercel dashboard, add `phantom.detour.ninja` as a
#      production domain on the linked project.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE="$ROOT/build/dev-macos-arm64/Detour-dev.app/Contents/Resources/app/views/main"
TARGET="$ROOT/build/vercel-phantom-redirect"

if [[ ! -d "$BUNDLE" ]]; then
	echo "[redeploy] bundle missing: $BUNDLE — run electrobun dev/build first" >&2
	exit 1
fi

mkdir -p "$TARGET"
# Rsync rather than rm + cp so vercel.json and .vercel/ link state survive.
rsync -a --delete \
	--exclude '.vercel' \
	--exclude 'vercel.json' \
	"$BUNDLE/" "$TARGET/"

echo "[redeploy] bundle staged at $TARGET"
cd "$TARGET"
vercel deploy --prod --yes
