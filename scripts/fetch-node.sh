#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Fetch the Node runtime and place it as the Tauri sidecar for a target triple.
# Used by CI and the macOS build script so the installer bundles Node (goal:
# no CLI installs). The agent is zero-dependency, so only the `node` binary is
# needed.
#
#   scripts/fetch-node.sh <rust-target-triple> [outdir]
#
# e.g. scripts/fetch-node.sh aarch64-apple-darwin app/src-tauri/binaries
set -euo pipefail

TRIPLE="${1:?usage: fetch-node.sh <rust-target-triple> [outdir]}"
OUTDIR="${2:-app/src-tauri/binaries}"
NODE_VERSION="${NODE_VERSION:-v22.11.0}"

case "$TRIPLE" in
  x86_64-apple-darwin)        PLAT=darwin-x64 ;;
  aarch64-apple-darwin)       PLAT=darwin-arm64 ;;
  x86_64-unknown-linux-gnu)   PLAT=linux-x64 ;;
  aarch64-unknown-linux-gnu)  PLAT=linux-arm64 ;;
  *) echo "unsupported triple: $TRIPLE" >&2; exit 1 ;;
esac

mkdir -p "$OUTDIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PKG="node-${NODE_VERSION}-${PLAT}"
URL="https://nodejs.org/dist/${NODE_VERSION}/${PKG}.tar.gz"
echo "Downloading $URL"
curl -fsSL "$URL" -o "$TMP/node.tar.gz"
tar -xzf "$TMP/node.tar.gz" -C "$TMP"

DEST="$OUTDIR/ophq-node-${TRIPLE}"
cp "$TMP/${PKG}/bin/node" "$DEST"
chmod +x "$DEST"
echo "Placed sidecar: $DEST"
