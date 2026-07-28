# SPDX-License-Identifier: AGPL-3.0-or-later
# OpenPrintHQ Cloud Client — remove the connector Windows service. Run elevated.
param([string]$ServiceName = "OpenPrintHQConnector")
$ErrorActionPreference = "SilentlyContinue"
if (Get-Service $ServiceName -ErrorAction SilentlyContinue) {
  sc.exe stop $ServiceName | Out-Null
  sc.exe delete $ServiceName | Out-Null
  Write-Host "Removed service '$ServiceName'."
} else {
  Write-Host "Service '$ServiceName' not present."
}
[Environment]::SetEnvironmentVariable("OPHQ_CONFIG_FILE", $null, "Machine")
[Environment]::SetEnvironmentVariable("OPHQ_AGENT_FILE", $null, "Machine")
