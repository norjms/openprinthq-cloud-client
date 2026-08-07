#!/usr/bin/env bash
# Native Linux / macOS build. Produces the same installers the release workflow
# does, without needing GitHub Actions.
#
#   ./scripts/build-local.sh                # version from tauri.conf.json
#   ./scripts/build-local.sh --version 0.0.9
#   ./scripts/build-local.sh --skip-fetch   # reuse already-downloaded sidecars
#
# Requires: Rust, Node, and cargo-tauri (cargo install tauri-cli --version "^2.0").
# Linux additionally needs the webkit2gtk/appindicator dev packages; the script
# names them rather than letting cargo fail 200 lines later with a linker error.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION=""; SKIP_FETCH=0
# cargo tauri rewrites Cargo.lock during the build, so switching tags in a reused
# checkout fails with "local changes would be overwritten". Building two tags in
# a row silently produced the first one twice on Windows and aborted on Linux.
git -C "$ROOT" checkout -- app/src-tauri/Cargo.lock 2>/dev/null || true
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --skip-fetch) SKIP_FETCH=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

case "$(uname -s)" in
  Darwin) OS=macos;  TRIPLES="$(uname -m | sed 's/arm64/aarch64/')-apple-darwin"; BUNDLES="app" ;;
  Linux)  OS=linux;  TRIPLES="x86_64-unknown-linux-gnu"; BUNDLES="deb,rpm" ;;
  *) echo "unsupported platform: $(uname -s)" >&2; exit 1 ;;
esac

for t in cargo node; do
  command -v "$t" >/dev/null || { echo "$t not found — install Rust and Node first" >&2; exit 1; }
done
command -v cargo-tauri >/dev/null || { echo 'cargo-tauri not found — cargo install tauri-cli --version "^2.0"' >&2; exit 1; }

if [ "$OS" = linux ] && command -v pkg-config >/dev/null; then
  missing=""
  # ayatana-appindicator is easy to miss: without it tauri-cli does not fail the
  # dependency check, it panics mid-build with "Can't detect any appindicator
  # library", which reads like a tooling bug rather than a missing package.
  for p in webkit2gtk-4.1 libsoup-3.0 javascriptcoregtk-4.1 ayatana-appindicator3-0.1; do
    pkg-config --exists "$p" 2>/dev/null || missing="$missing $p"
  done
  if [ -n "$missing" ]; then
    echo "missing dev packages:$missing" >&2
    echo "  Debian/Ubuntu: sudo apt install libwebkit2gtk-4.1-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf" >&2
    echo "  Fedora:        sudo dnf install webkit2gtk4.1-devel libsoup3-devel libayatana-appindicator-gtk3-devel librsvg2-devel" >&2
    exit 1
  fi
fi

CONF="$ROOT/app/src-tauri/tauri.conf.json"
if [ -n "$VERSION" ]; then
  # Keep every version marker in step, as the release workflow does.
  python3 - "$VERSION" <<'PY'
import re,sys
v=sys.argv[1]
for p,pat,rep in [('app/src-tauri/tauri.conf.json', r'"version":\s*"[^"]+"', f'"version": "{v}"'),
                  ('agent/package.json',            r'"version":\s*"[^"]+"', f'"version": "{v}"')]:
    s=open(p).read(); open(p,'w').write(re.sub(pat,rep,s,count=1))
s=open('app/src-tauri/Cargo.toml').read()
open('app/src-tauri/Cargo.toml','w').write(re.sub(r'^version\s*=\s*"[^"]+"',f'version = "{v}"',s,count=1,flags=re.M))
PY
fi
VER="$(python3 -c "import json;print(json.load(open('$CONF'))['version'])")"
echo "building OpenPrintHQ Cloud Client $VER ($OS)"

if [ "$SKIP_FETCH" -eq 0 ]; then
  for T in $TRIPLES; do
    echo "==> sidecars for $T"
    bash scripts/fetch-node.sh "$T" app/src-tauri/binaries
    bash scripts/fetch-camera-tools.sh "$T" app/src-tauri/binaries
  done
fi

if [ "$OS" = macos ]; then
  # macOS has its own assembly: a universal .app from both arches, then
  # productbuild into the .pkg that actually ships. build-local.sh stopping at
  # --bundles app produced a .app directory, which is not a distributable file
  # and silently yielded an empty dist/.
  echo "==> build-macos.sh (universal .app -> .pkg)"
  VERSION="$VER" TARGET=universal-apple-darwin bash scripts/build-macos.sh
else
  echo "==> cargo tauri build"
  ( cd app && cargo tauri build --bundles "$BUNDLES" )
fi

mkdir -p "$ROOT/dist"
find . app/src-tauri/target/release/bundle -maxdepth 4 -type f \( -name '*.deb' -o -name '*.rpm' -o -name '*.pkg' -o -name '*.dmg' \) \
  -exec cp {} "$ROOT/dist/" \; -exec sh -c 'printf "  %s  %.1f MB\n" "$(basename "$1")" "$(echo "scale=1; $(stat -c%s "$1" 2>/dev/null || stat -f%z "$1")/1048576" | bc)"' _ {} \;
echo "artifacts in $ROOT/dist"
