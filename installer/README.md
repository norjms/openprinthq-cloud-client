# Installers

Packaging for the OpenPrintHQ Cloud Client. The desktop app is built with Tauri;
these are the per-platform installer bits layered on top.

| Platform | Format | How it's built | Boot without login |
|----------|--------|----------------|--------------------|
| Windows  | `.msi` | `cargo tauri build --bundles msi` (WiX). CI signs it self-signed. | `service/windows/install-service.ps1` (wired via `installer/windows/service.wxs`) |
| macOS    | `.pkg` | `scripts/build-macos.sh` → `installer/macos/build-pkg.sh` (pkgbuild/productbuild) | LaunchDaemon (`service/launchd/…`), installed by the `.pkg` |
| Linux    | `.deb` / `.rpm` | `cargo tauri build --bundles deb,rpm` | `service/systemd/openprinthq-connector.service` |
| Any      | Docker | `docker build agent/` | `restart: unless-stopped` in compose |

## Windows (`windows/service.wxs`)

A WiX v3 fragment that, once wired into `tauri.conf.json`, registers the
background Windows service (via `service/install-service.ps1`) and an
outbound-allow firewall rule as deferred, elevated custom actions. It is kept
**unwired** until validated on the native-Windows runner so the base MSI always
builds. The shipped 0.0.1 MSI installs the app + bundled Node; the tray app
supervises the connector at login, and boot-without-login is enabled by the
service fragment or by running `install-service.ps1` elevated.

## macOS (`macos/`)

- `build-pkg.sh` — assembles a `.pkg` from a built `.app`: payload is
  `/Applications/OpenPrintHQ Cloud Client.app` + the LaunchDaemon plist; the
  `postinstall` loads the daemon and runs a self-test.
- `distribution.xml` — productbuild distribution (macOS 11+).
- `scripts/preinstall`, `scripts/postinstall` — daemon lifecycle + self-test.

Unsigned for 0.0.1 (an Apple Developer ID is tracked in the backlog).

## Linux (`linux/`)

`deb`/`rpm` come straight from the Tauri bundler. The systemd unit in
`service/systemd/` runs the connector headlessly; the deb declares a dependency
on `nodejs (>= 20)`.
