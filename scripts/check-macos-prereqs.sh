#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# =============================================================================
# OpenPrintHQ Cloud Client — macOS build preflight
# =============================================================================
# Checks that this Mac has what scripts/build-macos.sh needs, and flags the
# common gotcha (an Intel Rust toolchain on an Apple-Silicon Mac). Run it first:
#
#   ./scripts/check-macos-prereqs.sh
#
# Exit 0 = ready to build; non-zero = a blocking item needs fixing.
# =============================================================================
set -u

warn=0; fail=0
pass(){ printf '  \033[32m✓\033[0m %s\n' "$1"; }
warnf(){ printf '  \033[33m!\033[0m %s\n' "$1"; warn=$((warn+1)); }
failf(){ printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail+1)); }
note(){ printf '  · %s\n' "$1"; }
have(){ command -v "$1" >/dev/null 2>&1; }

echo "OpenPrintHQ Cloud Client — macOS build preflight"
echo

# --- OS + arch ---
if [ "$(uname -s)" = "Darwin" ]; then
  ver="$(sw_vers -productVersion 2>/dev/null || echo '?')"
  major="${ver%%.*}"
  if [ "${major:-0}" -ge 11 ] 2>/dev/null; then pass "macOS $ver"; else warnf "macOS $ver (11+ recommended)"; fi
else
  failf "not macOS — the .pkg must be built on a Mac"
fi
mach="$(uname -m)"
note "machine arch: $mach"

# --- C toolchain (Xcode CLT) ---
if xcode-select -p >/dev/null 2>&1 && have cc; then
  pass "Xcode command-line tools ($(xcode-select -p))"
elif have clang || have cc; then
  pass "C compiler present"
else
  failf "no C toolchain — run:  xcode-select --install"
fi

# --- Rust / cargo (+ the important host-triple check) ---
if have cargo; then
  pass "cargo: $(cargo --version 2>/dev/null)"
  rusthost="$(rustc -vV 2>/dev/null | awk '/^host:/{print $2}')"
  note "rust host triple: ${rusthost:-unknown}"
  if [ "$mach" = "arm64" ] && [ "$rusthost" = "x86_64-apple-darwin" ]; then
    warnf "Your Rust is Intel (x86_64) on an Apple-Silicon Mac. The build will still"
    printf '      succeed and produce a working \033[33mIntel\033[0m .pkg (runs via Rosetta).\n'
    printf '      For a native arm64 build instead, install the arm64 toolchain:\n'
    printf '        curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y\n'
    printf '        source "$HOME/.cargo/env" && rustup default stable-aarch64-apple-darwin\n'
  fi
else
  warnf "cargo not found — build-macos.sh will install rustup automatically (~2 min),"
  printf '      or install it yourself:  curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh\n'
fi

# --- optional: rustup + tauri-cli (build script handles both) ---
if have rustup; then pass "rustup present"; else note "rustup: not installed (fine for a native build)"; fi
if have cargo && cargo tauri --version >/dev/null 2>&1; then
  pass "tauri-cli: $(cargo tauri --version 2>/dev/null)"
else
  note "tauri-cli: not installed (build-macos.sh installs it, ~10 min first time)"
fi

# --- tools needed for fetch-node + packaging ---
for t in curl tar git; do
  if have "$t"; then pass "$t"; else failf "$t missing"; fi
done
if have pkgbuild && have productbuild; then pass "pkgbuild / productbuild"; else failf "pkgbuild/productbuild missing (part of macOS/CLT)"; fi
if have lipo; then pass "lipo (needed only for TARGET=universal)"; else note "lipo: not found (only needed for a universal build)"; fi

# --- disk ---
avail="$(df -g . 2>/dev/null | awk 'NR==2{print $4}')"
if [ -n "${avail:-}" ]; then
  if [ "$avail" -ge 5 ] 2>/dev/null; then pass "disk: ${avail} GB free"; else warnf "only ${avail} GB free (~4-5 GB needed)"; fi
fi

# --- network (bundled Node download) ---
if have curl; then
  if curl -fsS -m 8 -o /dev/null https://nodejs.org/dist/ 2>/dev/null; then
    pass "can reach nodejs.org (for the bundled Node runtime)"
  else
    warnf "cannot reach nodejs.org — needed to fetch the Node sidecar"
  fi
fi

echo
echo "Summary: ${fail} blocking issue(s), ${warn} warning(s)."
if [ "$fail" -eq 0 ]; then
  echo "Ready. Build with:      ./scripts/build-macos.sh"
  echo "Build + publish with:   GITEA_TOKEN=... ./scripts/build-macos.sh"
  echo "  (set GITEA_API=<your gitea>/api/v1 if the public API path is blocked from your network)"
  exit 0
else
  echo "Fix the ✗ item(s) above, then re-run this check."
  exit 1
fi
