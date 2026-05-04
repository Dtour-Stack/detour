#!/usr/bin/env bash
#
# Detour installer for macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/Dexploarer/detour/main/scripts/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/Dexploarer/detour/main/scripts/install.sh | bash -s -- 0.1.0
#   curl -fsSL https://raw.githubusercontent.com/Dexploarer/detour/main/scripts/install.sh | bash -s -- canary
#
# Pass a version (`0.1.0`) or `canary` as the first arg. With no arg, downloads
# the latest stable release.
#
# What this does:
#   1. Picks the right asset from the GitHub release (stable or canary).
#   2. Downloads + unzips it to a temp dir.
#   3. Strips the macOS quarantine xattr — required because the build is not
#      signed with an Apple Developer ID (we're a free OSS project, no $99/yr).
#   4. Moves Detour.app into /Applications, asking sudo if needed.

set -euo pipefail

REPO="Dexploarer/detour"
TARGET_VERSION="${1:-latest}"
INSTALL_DIR="${INSTALL_DIR:-/Applications}"

err()  { printf "\033[31m✗\033[0m %s\n" "$*" >&2; exit 1; }
log()  { printf "\033[36m→\033[0m %s\n" "$*"; }
done_(){ printf "\033[32m✓\033[0m %s\n" "$*"; }

[[ "$(uname -s)" == "Darwin" ]] || err "Detour is macOS-only (got $(uname -s))."

# ── Resolve which release to download ────────────────────────────────────
if [[ "$TARGET_VERSION" == "canary" ]]; then
  TAG="canary"
  ASSET="Detour-canary.zip"
elif [[ "$TARGET_VERSION" == "latest" ]]; then
  log "Resolving latest stable release..."
  TAG=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | head -1 | sed -E 's/.*"([^"]+)".*/\1/')
  [[ -n "$TAG" ]] || err "Couldn't resolve latest release."
  VER="${TAG#v}"
  ASSET="Detour-${VER}-stable.zip"
else
  TAG="v${TARGET_VERSION#v}"
  VER="${TARGET_VERSION#v}"
  ASSET="Detour-${VER}-stable.zip"
fi

URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"

# ── Download ──────────────────────────────────────────────────────────────
TMP=$(mktemp -d -t detour-install)
trap 'rm -rf "$TMP"' EXIT

log "Downloading ${ASSET} from ${TAG}..."
if ! curl -fL --progress-bar -o "${TMP}/Detour.zip" "$URL"; then
  err "Download failed: ${URL}"
fi

log "Extracting..."
ditto -x -k "${TMP}/Detour.zip" "${TMP}/extracted"

# Find the .app inside (Electrobun bundle name varies by env)
APP_PATH=$(find "${TMP}/extracted" -maxdepth 2 -name "*.app" -type d | head -1)
[[ -n "$APP_PATH" ]] || err "No .app bundle found inside ${ASSET}."
APP_NAME=$(basename "$APP_PATH")

# ── De-quarantine ────────────────────────────────────────────────────────
log "Stripping macOS quarantine attribute..."
xattr -dr com.apple.quarantine "$APP_PATH" 2>/dev/null || true

# ── Install ──────────────────────────────────────────────────────────────
DEST="${INSTALL_DIR}/${APP_NAME}"

if [[ -d "$DEST" ]]; then
  log "Removing existing install at ${DEST}..."
  if [[ -w "$INSTALL_DIR" ]]; then
    rm -rf "$DEST"
  else
    sudo rm -rf "$DEST"
  fi
fi

log "Installing to ${DEST}..."
if [[ -w "$INSTALL_DIR" ]]; then
  ditto "$APP_PATH" "$DEST"
else
  sudo ditto "$APP_PATH" "$DEST"
fi

done_ "Detour installed at ${DEST}"
echo
echo "Open it from Applications, or run: open \"${DEST}\""
