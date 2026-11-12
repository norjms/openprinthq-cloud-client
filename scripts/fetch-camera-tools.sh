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

# macOS x86_64 ffmpeg, pinned. evermeet.cx (the previous source) now answers
# 410 Gone, so the Intel build fetches evermeet's static FFmpeg 8.0 build as
# republished in the ffmpeg-static project's GitHub release b6.1.1. The release
# tag fixes the file and the SHA-256 below is checked before it is used, so a
# changed or truncated download fails the build. GPL-3.0-or-later, see
# THIRD_PARTY_NOTICES.md.
FFMPEG_MAC_X64_URL="https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-darwin-x64.gz"
FFMPEG_MAC_X64_SHA256="929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106"

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

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

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
# Static builds: macOS from OSXExperts (arm64) and evermeet via ffmpeg-static (x86_64, pinned),
# Linux from John Van Sickle (amd64/arm64).
if [ "$OS" = "linux" ]; then
  if [ "$ARCH" = "amd64" ]; then FFURL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"; else FFURL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz"; fi
  # Download with retries and verify it's a real xz archive before extracting
  # (a truncated/HTML response would make tar fail hard under set -e).
  ok=0
  for attempt in 1 2 3 4; do
    curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 300 "$FFURL" -o "$TMP/ffmpeg.tar.xz" || { sleep 3; continue; }
    # xz magic bytes: FD 37 7A 58 5A 00
    if [ -s "$TMP/ffmpeg.tar.xz" ] && head -c 6 "$TMP/ffmpeg.tar.xz" | od -An -tx1 | grep -q "fd 37 7a 58 5a 00"; then ok=1; break; fi
    echo "ffmpeg download attempt $attempt was not a valid xz archive, retrying" >&2; sleep 3
  done
  [ "$ok" = 1 ] || { echo "ERROR: could not download a valid ffmpeg archive for $TRIPLE" >&2; exit 1; }
  ( cd "$TMP" && tar -xJf ffmpeg.tar.xz )
  FFBIN="$(find "$TMP" -type f -name ffmpeg | head -1)"
elif [ "$ARCH" = "arm64" ]; then
  # macOS arm64: native static build from OSXExperts.
  FFURL="https://www.osxexperts.net/ffmpeg711arm.zip"
  if curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 "$FFURL" -o "$TMP/ffmpeg.zip" 2>/dev/null && [ -s "$TMP/ffmpeg.zip" ]; then
    ( cd "$TMP" && unzip -o -q ffmpeg.zip )
    FFBIN="$(find "$TMP" -type f -name ffmpeg | head -1)"
  fi
else
  # macOS x86_64: the pinned build above, checked against its SHA-256.
  curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 300 "$FFMPEG_MAC_X64_URL" -o "$TMP/ffmpeg.gz"
  GOT="$(sha256_of "$TMP/ffmpeg.gz")"
  if [ "$GOT" != "$FFMPEG_MAC_X64_SHA256" ]; then
    echo "ERROR: ffmpeg for $TRIPLE failed its checksum" >&2
    echo "       expected $FFMPEG_MAC_X64_SHA256" >&2
    echo "       got      $GOT" >&2
    exit 1
  fi
  gunzip -c "$TMP/ffmpeg.gz" > "$TMP/ffmpeg"
  FFBIN="$TMP/ffmpeg"
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
