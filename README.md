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
self-test connectivity to your instance and to your printers.

## Layout
- `agent/` — the connector agent (Node, zero-dependency): opens an outbound SSE stream to your
  instance and proxies requested HTTP calls to printers on your LAN. Runnable standalone
  (Linux/Docker) or embedded in the desktop installers.
- `app/` — desktop app (Tauri): tray/menu-bar UI + service supervisor. *(in progress)*
- `installer/`, `service/`, `.gitea/workflows/` — packaging, service definitions, CI. *(in progress)*

## Get it
Download from your OpenPrintHQ dashboard (**Printers → Connect a printer**) or the
[Releases](../../releases) page. See `agent/README.md` for the standalone/Docker agent.

## License
AGPL-3.0-or-later. See [LICENSE](LICENSE).
