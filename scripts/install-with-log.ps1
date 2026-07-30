<#  SPDX-License-Identifier: AGPL-3.0-or-later
    install-with-log.ps1 — install (or uninstall) the OpenPrintHQ Cloud Client
    MSI with full verbose logging, so a slow or seemingly-stuck install can be
    diagnosed (issue #2). The stock double-click install gives no feedback while
    the ~80 MB bundled Node runtime and resources are written, and none while the
    optional service/firewall CustomActions run hidden. This wrapper makes the
    whole thing observable.

    Examples:
      # install, logging to a timestamped file on the Desktop
      powershell -ExecutionPolicy Bypass -File install-with-log.ps1 -Msi .\OpenPrintHQ_x64.msi

      # quiet/unattended install with a log
      powershell -ExecutionPolicy Bypass -File install-with-log.ps1 -Msi .\OpenPrintHQ_x64.msi -Quiet

      # uninstall with a log
      powershell -ExecutionPolicy Bypass -File install-with-log.ps1 -Msi .\OpenPrintHQ_x64.msi -Uninstall
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $Msi,
  [string] $LogPath,
  [switch] $Quiet,
  [switch] $Uninstall
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Msi)) { throw "MSI not found: $Msi" }
$Msi = (Resolve-Path $Msi).Path

if (-not $LogPath) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $desk  = [Environment]::GetFolderPath('Desktop')
  $LogPath = Join-Path $desk "OpenPrintHQ-install-$stamp.log"
}

$verb = if ($Uninstall) { '/x' } else { '/i' }
# /l*v = verbose logging of everything; !+ = flush each line so a hang is visible live.
$args = @($verb, "`"$Msi`"", '/l*v', "`"$LogPath`"")
if ($Quiet) { $args += '/qn' } else { $args += '/qb!' }  # /qb! = basic UI, no Cancel, still shows progress

Write-Host "OpenPrintHQ Cloud Client installer"
Write-Host "  action : $(if ($Uninstall) {'uninstall'} else {'install'})"
Write-Host "  msi    : $Msi"
Write-Host "  log    : $LogPath"
Write-Host "  (tail the log in another window with:  Get-Content -Wait `"$LogPath`" )"
Write-Host ""

$sw = [Diagnostics.Stopwatch]::StartNew()
$p  = Start-Process msiexec.exe -ArgumentList $args -Wait -PassThru
$sw.Stop()

$code = $p.ExitCode
Write-Host ""
Write-Host ("Finished in {0:n1}s with exit code {1}." -f $sw.Elapsed.TotalSeconds, $code)
switch ($code) {
  0    { Write-Host "Success." }
  3010 { Write-Host "Success — a reboot is required to finish." }
  1602 { Write-Warning "User cancelled the install." }
  1603 { Write-Warning "Fatal error during install. See the log: $LogPath" }
  default { Write-Warning "Non-zero exit ($code). See the log: $LogPath" }
}
Write-Host "Log saved to: $LogPath"
exit $code
