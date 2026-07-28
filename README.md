# OpenPrintHQ Cloud Client

The client that connects a cloud-hosted [OpenPrintHQ](https://openprinthq.com) account to the
3D printers on your local network — **outbound-only**, so it works behind a home router, a
company firewall, or CGNAT with **no port-forwarding** and no inbound firewall rules.

It ships as:

- **Windows** — `.msi` installer (background service + system-tray app).
- **macOS** — `.pkg` installer (LaunchDaemon + menu-bar app).
- **Linux** — `.deb` / `.rpm` (systemd service).
- **Docker** — image + compose.

The Windows/macOS installers run a background **service** (starts at boot, no login required)
plus a small **tray / menu-bar app** for status, token entry, and updates. On install they
self-test connectivity to your instance and to your printers. Everything is outbound-only.

## Layout

- `agent/` — the connector agent (Node, zero-dependency): opens an outbound SSE stream to your
  instance and proxies requested HTTP/TCP calls to printers on your LAN. Runnable standalone
  (Linux/Docker) or embedded in the desktop installers.
- `app/` — desktop app (Tauri): tray/menu-bar UI + agent supervisor. It stores config in a
  machine-wide `config.json`, spawns the bundled Node connector, shows live status, runs a
  self-test, prints the connector key, and checks for updates.
- `service/` — platform service definitions (Windows Service / launchd LaunchDaemon / systemd)
  that run the connector at boot with no login, sharing the same `config.json`.
- `scripts/` — the shared launcher (`run-connector.mjs`), connectivity self-test, outbound-allow
  helper, update check, and the Node-sidecar fetcher. `build-macos.sh` builds + publishes the
  macOS `.pkg`.
- `installer/` — WiX (`.msi`), pkgbuild (`.pkg`), and packaging notes.
- `.gitea/workflows/` — CI: `build-linux.yml`, `build-windows.yml`, and `release.yml`.

## Build from source

```bash
# Linux (.deb/.rpm) — needs the Tauri Linux deps + Rust + Node
scripts/fetch-node.sh x86_64-unknown-linux-gnu app/src-tauri/binaries
cd app && cargo tauri build --bundles deb,rpm

# Windows (.msi) — needs Rust + Node + tauri-cli (WiX auto-downloaded)
powershell -File scripts/fetch-node.ps1 -Triple x86_64-pc-windows-msvc -OutDir app/src-tauri/binaries
cd app; cargo tauri build --bundles msi

# macOS (.pkg) — one script does toolchain -> build -> package -> (optional) publish
./scripts/build-macos.sh
```

## Get it

Download from your OpenPrintHQ dashboard (**Printers → Connect a printer**) or the
[Releases](../../releases) page. See `agent/README.md` for the standalone/Docker agent.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
