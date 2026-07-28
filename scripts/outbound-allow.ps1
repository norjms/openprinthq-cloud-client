# SPDX-License-Identifier: AGPL-3.0-or-later
# OpenPrintHQ Cloud Client — register an outbound-allow firewall rule (Windows).
#
# The connector is OUTBOUND-ONLY: it never listens for inbound connections, so
# no inbound port needs to be opened. Windows allows outbound traffic by
# default, but on hardened machines with a default-deny outbound policy this
# rule explicitly permits the bundled Node connector to dial out. Run elevated.
#
#   powershell -ExecutionPolicy Bypass -File outbound-allow.ps1 [-Program <path\to\ophq-node.exe>]

param(
  [string]$Program = "$env:ProgramFiles\OpenPrintHQ Cloud Client\ophq-node.exe",
  [string]$RuleName = "OpenPrintHQ Connector (outbound)"
)

$ErrorActionPreference = "Stop"

if (Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue) {
  Write-Host "Firewall rule '$RuleName' already exists."
  exit 0
}

New-NetFirewallRule `
  -DisplayName $RuleName `
  -Direction Outbound `
  -Action Allow `
  -Program $Program `
  -Profile Any `
  -Description "Allow the OpenPrintHQ connector to make outbound HTTPS connections to your cloud instance. No inbound ports are opened." | Out-Null

Write-Host "Added outbound-allow firewall rule '$RuleName' for $Program."
