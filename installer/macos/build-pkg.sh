#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Assemble a macOS .pkg from an already-built .app bundle.
#
#   installer/macos/build-pkg.sh <path-to-.app> <version> [out.pkg]
#
# The .pkg installs the app to /Applications and the LaunchDaemon to
# /Library/LaunchDaemons, then runs the postinstall (load daemon + self-test).
# Called by scripts/build-macos.sh; can be run standalone too. Unsigned for
# 0.0.1 (a Developer ID is tracked in the backlog).
set -euo pipefail

APP_PATH="${1:?usage: build-pkg.sh <path-to-.app> <version> [out.pkg]}"
VERSION="${2:?version required, e.g. 0.0.1}"
OUT="${3:-OpenPrintHQ-Cloud-Client-${VERSION}.pkg}"

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
IDENT="com.openprinthq.cloudclient"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- payload: /Applications/<app> ---
mkdir -p "$WORK/root/Applications"
cp -R "$APP_PATH" "$WORK/root/Applications/"

# --- payload: LaunchDaemon ---
mkdir -p "$WORK/root/Library/LaunchDaemons"
cp "$REPO/service/launchd/com.openprinthq.connector.plist" \
   "$WORK/root/Library/LaunchDaemons/com.openprinthq.connector.plist"
chmod 644 "$WORK/root/Library/LaunchDaemons/com.openprinthq.connector.plist"

# --- scripts ---
mkdir -p "$WORK/scripts"
cp "$HERE/scripts/preinstall" "$HERE/scripts/postinstall" "$WORK/scripts/"
chmod +x "$WORK/scripts/preinstall" "$WORK/scripts/postinstall"

# --- component pkg ---
pkgbuild \
  --root "$WORK/root" \
  --scripts "$WORK/scripts" \
  --identifier "$IDENT" \
  --version "$VERSION" \
  --install-location "/" \
  "$WORK/component.pkg"

# --- product pkg (with distribution.xml) ---
productbuild \
  --distribution "$HERE/distribution.xml" \
  --package-path "$WORK" \
  --resources "$HERE" \
  "$OUT"

echo "Built $OUT"
