#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Fetch go2rtc + ffmpeg and place them as Tauri sidecars for a target triple
# (macOS + Linux), so the installer bundles them and the connector can relay
# printer cameras with no manual install.
#
# Camera relay architecture credit: OctoEverywhere by Quinn Damerell
# (https://github.com/QuinnDamerell/OctoPrint-OctoEverywhere, AGPL-3.0).
#
#   scripts/fetch-camera-tools.sh <rust-target-triple> [outdir]
#   e.g. scripts/fetch-camera-tools.sh aarch64-apple-darwin app/src-tauri/binaries
set -euo pipefail

TRIPLE="${1:?usage: fetch-camera-tools.sh <rust-target-triple> [outdir]}"
OUTDIR="${2:-app/src-tauri/binaries}"
GO2RTC_VERSION="${GO2RTC_VERSION:-1.9.9}"

# go2rtc release asset name per platform (single static binary in a zip).
case "$TRIPLE" in
  x86_64-apple-darwin)        G2=go2rtc_mac_amd64 ; OS=mac ; ARCH=amd64 ;;
  aarch64-apple-darwin)       G2=go2rtc_mac_arm64 ; OS=mac ; ARCH=arm64 ;;
  x86_64-unknown-linux-gnu)   G2=go2rtc_linux_amd64 ; OS=linux ; ARCH=amd64 ;;
  aarch64-unknown-linux-gnu)  G2=go2rtc_linux_arm64 ; OS=linux ; ARCH=arm64 ;;
  *) echo "unsupported triple: $TRIPLE" >&2; exit 1 ;;
esac

mkdir -p "$OUTDIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- go2rtc ---
# go2rtc ships mac/linux binaries either raw or zipped depending on release.
# Try the zip first, fall back to the raw binary asset.
G2ZIP="https://github.com/AlexxIT/go2rtc/releases/download/v${GO2RTC_VERSION}/${G2}.zip"
G2RAW="https://github.com/AlexxIT/go2rtc/releases/download/v${GO2RTC_VERSION}/${G2}"
if curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 "$G2ZIP" -o "$TMP/go2rtc.zip" 2>/dev/null && [ -s "$TMP/go2rtc.zip" ]; then
  ( cd "$TMP" && unzip -o -q go2rtc.zip )
  G2BIN="$(find "$TMP" -type f -name 'go2rtc*' ! -name '*.zip' | head -1)"
else
  curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 "$G2RAW" -o "$TMP/go2rtc"
  G2BIN="$TMP/go2rtc"
fi
[ -n "${G2BIN:-}" ] && [ -s "$G2BIN" ] || { echo "go2rtc download failed" >&2; exit 1; }
cp "$G2BIN" "$OUTDIR/go2rtc-${TRIPLE}"
chmod +x "$OUTDIR/go2rtc-${TRIPLE}"

# --- ffmpeg (used by go2rtc for the RTSPS->MJPEG transcode) ---
# Static builds: macOS from evermeet (x64) / OSXExperts, Linux from John Van Sickle (amd64/arm64).
if [ "$OS" = "linux" ]; then
  if [ "$ARCH" = "amd64" ]; then FFURL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"; else FFURL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz"; fi
  curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 "$FFURL" -o "$TMP/ffmpeg.tar.xz"
  ( cd "$TMP" && tar -xJf ffmpeg.tar.xz )
  FFBIN="$(find "$TMP" -type f -name ffmpeg | head -1)"
else
  # macOS: evermeet provides a zipped static ffmpeg (x86_64); on Apple Silicon it runs under Rosetta,
  # but prefer a native arm64 build from OSXExperts when available.
  if [ "$ARCH" = "arm64" ]; then FFURL="https://www.osxexperts.net/ffmpeg711arm.zip"; else FFURL="https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip"; fi
  if curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 "$FFURL" -o "$TMP/ffmpeg.zip" 2>/dev/null && [ -s "$TMP/ffmpeg.zip" ]; then
    ( cd "$TMP" && unzip -o -q ffmpeg.zip )
    FFBIN="$(find "$TMP" -type f -name ffmpeg | head -1)"
  fi
fi
# ffmpeg is REQUIRED: Bambu RTSPS is H.264, and go2rtc needs ffmpeg to transcode
# to JPEG for /api/frame.jpeg snapshots. Fail loudly if we couldn't fetch it.
if [ -n "${FFBIN:-}" ] && [ -s "$FFBIN" ]; then
  cp "$FFBIN" "$OUTDIR/ffmpeg-${TRIPLE}"
  chmod +x "$OUTDIR/ffmpeg-${TRIPLE}"
else
  echo "ERROR: could not fetch a static ffmpeg for $TRIPLE (required for camera transcode)" >&2
  exit 1
fi

echo "Placed camera sidecars: go2rtc-${TRIPLE}, ffmpeg-${TRIPLE} -> $OUTDIR"
ls -la "$OUTDIR" | grep -E "go2rtc|ffmpeg" || true
