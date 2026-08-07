# Building releases locally

Every installer can be produced on a developer machine without GitHub Actions.
That began as a workaround during an Actions outage, but it is worth keeping: it
lets a change be tested before it is tagged, and it removes a single point of
failure from shipping.

    scripts/build-local.ps1     # Windows  -> .msi
    scripts/build-local.sh      # Linux    -> .deb + .rpm
    scripts/build-local.sh      # macOS    -> .pkg (universal)

Both accept `--version X.Y.Z` (`-Version` on PowerShell) and keep every version
marker in step the way the release workflow does. Artifacts land in `dist/`.

## One host per platform

There is no cross-compiling. Each platform needs a machine of that kind:

| Target | Host | Produces |
|---|---|---|
| Windows x86_64 | Windows with Rust + Node + cargo-tauri | `.msi` |
| Linux x86_64 | Linux (WSL2 is fine) | `.deb`, `.rpm` |
| macOS universal | Apple Silicon Mac with Xcode CLT | `.pkg` |
| Connector image | anything with Docker buildx + QEMU | multi-arch amd64/arm64 |

WSL2 is a perfectly good Linux builder. Check `.wslconfig` first — the default
can be far below the host's real capacity, which makes it slower than a small VM
for no reason.

## Prerequisites

    # all platforms
    cargo install tauri-cli --version "^2.0"

    # Debian/Ubuntu (incl. WSL)
    sudo apt install build-essential pkg-config libssl-dev librsvg2-dev patchelf \
      libwebkit2gtk-4.1-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev \
      libayatana-appindicator3-dev rpm

    # macOS: Xcode Command Line Tools, plus both targets for universal binaries
    rustup target add x86_64-apple-darwin aarch64-apple-darwin

## Things that cost time the first time

**Restore `Cargo.lock` between tags.** `cargo tauri build` rewrites it, so
switching tags in a reused checkout fails with "local changes would be
overwritten". Linux aborts loudly; Windows carried on and built the *previous*
tag twice under two different version folders — silently shipping the wrong
binary under the right version number. `build-local` now restores it first, but
if you script your own loop, use `git checkout -f`.

**appindicator is not caught by the dependency check.** Without it tauri-cli
compiles the whole project and then panics with "Can't detect any appindicator
library", which reads like a tooling bug. `build-local.sh` now checks for it up
front.

**macOS needs `build-macos.sh`, not `--bundles app`.** `--bundles app` produces
a `.app` directory, which is not a distributable file — `dist/` comes out empty
and the build looks successful. `build-macos.sh` assembles a universal `.app`
from both arches and wraps it with `productbuild`.

**A full build is ~1.5 GB of `target/` per tag.** Building several tags in a row
will fill a modest disk; clear `target/release/bundle` between them.

**Verify what you built.** Two builds of different tags can produce
same-sized artifacts, so check the version is really inside:

    pkgutil --expand-full X.pkg /tmp/x && plutil -extract CFBundleVersion raw \
      "$(find /tmp/x -name Info.plist -path '*Contents*' | head -1)"

## Publishing

    gh release create vX.Y.Z path/to/*.msi path/to/*.deb path/to/*.rpm path/to/*.pkg \
      --title "OpenPrintHQ Cloud Client X.Y.Z" --notes "..."

Large artifacts can be uploaded straight from the machine that built them via
the releases API, which avoids moving hundreds of megabytes across the network
twice.

The connector image is separate and built from `agent/`:

    docker buildx build --platform linux/amd64,linux/arm64 \
      -t ghcr.io/norjms/openprinthq-connector:X.Y.Z --push agent/

## When Actions is available

Tag-triggered releases are still the normal path. If pushes are not starting
runs — GitHub throttles webhooks during incidents — `workflow_dispatch` bypasses
that entirely and does not need a new tag:

    gh workflow run release --ref vX.Y.Z -f version=X.Y.Z
