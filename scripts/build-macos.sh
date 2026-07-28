#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# =============================================================================
# OpenPrintHQ Cloud Client — macOS build & release (run this on your Mac)
# =============================================================================
# One script: install the toolchain (rustup + tauri-cli), bundle the Node
# runtime, build the .app, assemble the .pkg (installs a LaunchDaemon so the
# connector runs at boot with no login), and — if you provide a Gitea token —
# create/publish the release and upload the .pkg.
#
# Prerequisites: macOS 11+, Xcode Command Line Tools (`xcode-select --install`),
# curl, tar. Node is NOT required (the build bundles its own).
#
# Usage:
#   # from a fresh clone of the repo:
#   git clone https://git.nnlink.org/OpenPrintHQ/openprinthq-cloud-client.git
#   cd openprinthq-cloud-client
#   # build only:
#   ./scripts/build-macos.sh
#   # build AND publish the 0.0.1 release + upload the .pkg:
#   GITEA_TOKEN=xxxxx ./scripts/build-macos.sh
#
# Env knobs:
#   VERSION      release/tag version         (default: 0.0.1)
#   TARGET       rust target triple          (default: host arch)
#                aarch64-apple-darwin | x86_64-apple-darwin | universal-apple-darwin
#   GITEA_TOKEN  Gitea token -> publish + upload the .pkg (omit to build only)
#   GITEA_API    Gitea API base              (default: https://git.nnlink.org/api/v1)
#                If the public API path is blocked from your network, set this to
#                your Gitea's LAN endpoint, e.g. http://<gitea-lan-ip>:3000/api/v1
#   OWNER/REPO   repo coordinates            (default: OpenPrintHQ/openprinthq-cloud-client)
# =============================================================================
set -euo pipefail

VERSION="${VERSION:-0.0.1}"
OWNER="${OWNER:-OpenPrintHQ}"
REPO="${REPO:-openprinthq-cloud-client}"
GITEA_API="${GITEA_API:-https://git.nnlink.org/api/v1}"

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT"

# --- host arch -> default target (authoritative value set after toolchain) ---
USER_TARGET="${TARGET:-}"
if [ "$(uname -m)" = "arm64" ]; then HOST_TRIPLE="aarch64-apple-darwin"; else HOST_TRIPLE="x86_64-apple-darwin"; fi

# --- toolchain --------------------------------------------------------------
if ! command -v cargo >/dev/null 2>&1; then
  echo "==> Installing Rust (rustup)..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  # shellcheck disable=SC1090
  source "$HOME/.cargo/env"
fi
export PATH="$HOME/.cargo/bin:$PATH"

# Authoritative host triple from the actual Rust toolchain — a plain cargo can
# be x86_64 even on an Apple-Silicon Mac (e.g. an Intel Homebrew install), so we
# match the bundled Node sidecar and build target to it rather than to uname.
RUSTC_HOST="$(rustc -vV 2>/dev/null | awk '/^host:/{print $2}')"
[ -n "$RUSTC_HOST" ] && HOST_TRIPLE="$RUSTC_HOST"
if [ -n "$USER_TARGET" ]; then TARGET="$USER_TARGET"; else TARGET="$HOST_TRIPLE"; fi
echo "==> Building $OWNER/$REPO v$VERSION for $TARGET (rust host: $HOST_TRIPLE)"

if command -v rustup >/dev/null 2>&1; then
  if [ "$TARGET" = "universal-apple-darwin" ]; then
    rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
  else
    rustup target add "$TARGET" >/dev/null || true
  fi
else
  echo "==> rustup not found; assuming the target toolchain is already installed (fine for a native build)."
fi

if ! cargo tauri --version >/dev/null 2>&1; then
  echo "==> Installing tauri-cli..."
  cargo install tauri-cli --version '^2.0' --locked
fi

# --- bundle the Node sidecar ------------------------------------------------
echo "==> Fetching bundled Node runtime..."
if [ "$TARGET" = "universal-apple-darwin" ]; then
  bash "$HERE/fetch-node.sh" aarch64-apple-darwin  "app/src-tauri/binaries"
  bash "$HERE/fetch-node.sh" x86_64-apple-darwin   "app/src-tauri/binaries"
  if command -v lipo >/dev/null 2>&1; then
    lipo -create \
      "app/src-tauri/binaries/ophq-node-aarch64-apple-darwin" \
      "app/src-tauri/binaries/ophq-node-x86_64-apple-darwin" \
      -output "app/src-tauri/binaries/ophq-node-universal-apple-darwin"
    chmod +x "app/src-tauri/binaries/ophq-node-universal-apple-darwin"
  fi
else
  bash "$HERE/fetch-node.sh" "$TARGET" "app/src-tauri/binaries"
fi

# --- build the app ----------------------------------------------------------
echo "==> tauri build..."
if [ "$TARGET" = "$HOST_TRIPLE" ]; then
  # Native build: omit --target so a plain cargo (no rustup-managed target std)
  # builds against the host toolchain that's already present.
  ( cd app && cargo tauri build --bundles app )
  APP_DIR="app/src-tauri/target/release/bundle/macos"
else
  # Cross / universal build: --target is required (and so is rustup + the target).
  ( cd app && cargo tauri build --target "$TARGET" --bundles app )
  APP_DIR="app/src-tauri/target/$TARGET/release/bundle/macos"
fi
APP_PATH="$(/usr/bin/find "$APP_DIR" -maxdepth 1 -name '*.app' | head -n1)"
[ -n "$APP_PATH" ] || { echo "ERROR: no .app produced under $APP_DIR"; exit 1; }
echo "==> Built app: $APP_PATH"

# --- assemble the .pkg ------------------------------------------------------
PKG="OpenPrintHQ-Cloud-Client-${VERSION}-macos.pkg"
bash "$ROOT/installer/macos/build-pkg.sh" "$APP_PATH" "$VERSION" "$ROOT/$PKG"
echo "==> Built package: $ROOT/$PKG"

# --- publish (optional) -----------------------------------------------------
if [ -z "${GITEA_TOKEN:-}" ]; then
  echo
  echo "Build complete. To publish, re-run with GITEA_TOKEN=... (creates the"
  echo "v$VERSION release and uploads $PKG)."
  exit 0
fi

echo "==> Publishing release v$VERSION and uploading the .pkg..."
AUTH="Authorization: token ${GITEA_TOKEN}"
TAG="v${VERSION}"

REL_JSON="$(curl -fsS -H "$AUTH" "${GITEA_API}/repos/${OWNER}/${REPO}/releases/tags/${TAG}" 2>/dev/null || true)"
REL_ID="$(printf '%s' "$REL_JSON" | python3 -c 'import sys,json
try:
  print(json.load(sys.stdin).get("id",""))
except Exception:
  print("")' 2>/dev/null || true)"

if [ -z "$REL_ID" ]; then
  REL_JSON="$(curl -fsS -X POST -H "$AUTH" -H 'Content-Type: application/json' \
    "${GITEA_API}/repos/${OWNER}/${REPO}/releases" \
    -d "{\"tag_name\":\"${TAG}\",\"target_commitish\":\"main\",\"name\":\"OpenPrintHQ Cloud Client ${VERSION} (beta)\",\"body\":\"Beta ${VERSION}. macOS .pkg (unsigned) built on a Mac.\",\"draft\":false,\"prerelease\":true}")"
  REL_ID="$(printf '%s' "$REL_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')"
  echo "   created release id=$REL_ID"
else
  echo "   reusing release id=$REL_ID"
fi

curl -fsS -X POST -H "$AUTH" \
  -H 'Content-Type: application/octet-stream' \
  "${GITEA_API}/repos/${OWNER}/${REPO}/releases/${REL_ID}/assets?name=$(basename "$PKG")" \
  --data-binary @"$ROOT/$PKG" >/dev/null
echo "==> Uploaded $(basename "$PKG") to release ${TAG}."
echo "Done."
