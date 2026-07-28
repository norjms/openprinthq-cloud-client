# SPDX-License-Identifier: AGPL-3.0-or-later
# OpenPrintHQ Cloud Client — install the connector as a Windows service.
#
# Registers an auto-start service that runs the bundled Node sidecar against
# run-connector.mjs, reading C:\ProgramData\OpenPrintHQ\config.json (written by
# the tray app). Starts at boot with no login. Run elevated. The MSI runs this
# on install; you can also run it by hand after configuring the tray app.
#
#   powershell -ExecutionPolicy Bypass -File install-service.ps1 `
#       [-InstallDir "C:\Program Files\OpenPrintHQ Cloud Client"]

param(
  [string]$InstallDir = "$env:ProgramFiles\OpenPrintHQ Cloud Client",
  [string]$ServiceName = "OpenPrintHQConnector",
  [string]$ConfigDir = "$env:ProgramData\OpenPrintHQ"
)

$ErrorActionPreference = "Stop"

$node = Join-Path $InstallDir "node.exe"
$launcher = Join-Path $InstallDir "scripts\run-connector.mjs"
$agent = Join-Path $InstallDir "agent\src\agent.js"
if (-not (Test-Path $node)) { throw "bundled node.exe not found at $node" }
if (-not (Test-Path $launcher)) { throw "run-connector.mjs not found at $launcher" }

New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null

# Machine env so the service (LocalSystem) finds the config + agent.
[Environment]::SetEnvironmentVariable("OPHQ_CONFIG_FILE", (Join-Path $ConfigDir "config.json"), "Machine")
[Environment]::SetEnvironmentVariable("OPHQ_AGENT_FILE", $agent, "Machine")

$bin = "`"$node`" `"$launcher`""
if (Get-Service $ServiceName -ErrorAction SilentlyContinue) {
  sc.exe stop $ServiceName | Out-Null
  sc.exe delete $ServiceName | Out-Null
  Start-Sleep -Seconds 1
}
sc.exe create $ServiceName binPath= $bin start= auto DisplayName= "OpenPrintHQ Connector" | Out-Null
sc.exe description $ServiceName "Outbound tunnel so OpenPrintHQ can reach LAN printers behind NAT/CGNAT. Outbound-only; no inbound ports." | Out-Null
sc.exe failure $ServiceName reset= 60 actions= restart/5000/restart/5000/restart/5000 | Out-Null

# Only start now if a config already exists; otherwise it will start on next
# boot after the user configures the tray app.
if (Test-Path (Join-Path $ConfigDir "config.json")) {
  Start-Service $ServiceName
  Write-Host "Installed and started '$ServiceName'."
} else {
  Write-Host "Installed '$ServiceName' (auto-start). Configure the tray app, then: Start-Service $ServiceName"
}
