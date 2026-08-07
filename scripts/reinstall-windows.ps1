<#
.SYNOPSIS
  Uninstall and reinstall the OpenPrintHQ Cloud Client on Windows, preserving pairing.

.DESCRIPTION
  Iterating on the connector means reinstalling often, and doing it by hand is
  both slow and risky: the connector's private key lives in ProgramData, and if
  an uninstall removes it the connector comes back with a NEW key. The
  control-plane has already locked onto the old one (trust on first use), so it
  is rejected on every connect and the printer silently stops responding -- the
  failure looks like a broken client rather than a lost key.

  So state is copied out before removal and restored afterwards, always.

.EXAMPLE
  .\reinstall-windows.ps1                      # newest .msi in dist\
  .\reinstall-windows.ps1 -Msi C:\path\x.msi
  .\reinstall-windows.ps1 -Version 0.0.9       # download that release from GitHub
  .\reinstall-windows.ps1 -Fresh               # deliberately discard pairing
#>
[CmdletBinding()]
param(
  [string]$Msi,
  [string]$Version,
  [switch]$Fresh,
  [switch]$KeepRunning
)
$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
      ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this from an elevated PowerShell -- msiexec needs administrator."
}

$State  = "$env:PROGRAMDATA\openprinthq"
$Backup = Join-Path $env:TEMP ("ophq-state-" + (Get-Date -Format yyyyMMddHHmmss))
$repo   = Split-Path $PSScriptRoot -Parent

# ---- locate the installer -------------------------------------------------
if ($Version) {
  $url = "https://github.com/norjms/openprinthq-cloud-client/releases/download/v$Version/OpenPrintHQ.Cloud.Client_${Version}_x64_en-US.msi"
  $Msi = Join-Path $env:TEMP "ophq-$Version.msi"
  Write-Host "==> downloading $Version"
  Invoke-WebRequest -Uri $url -OutFile $Msi -UseBasicParsing
} elseif (-not $Msi) {
  # Newest by write time, not by name: a build folder often still holds older
  # MSIs, and a wildcard there will happily install the wrong version.
  $c = Get-ChildItem "$repo\dist\*.msi" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $c) { throw "No .msi given and none found in $repo\dist. Use -Msi or -Version." }
  $Msi = $c.FullName
}
if (-not (Test-Path $Msi)) { throw "installer not found: $Msi" }
Write-Host "installer: $Msi" -ForegroundColor Cyan

# ---- stop anything holding files open -------------------------------------
Get-Process -Name 'openprinthq-cloud-client','ophq-node','go2rtc','ffmpeg' -ErrorAction SilentlyContinue |
  ForEach-Object { Write-Host "  stopping $($_.ProcessName)"; $_ | Stop-Process -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

# ---- preserve pairing ------------------------------------------------------
if (-not $Fresh -and (Test-Path $State)) {
  New-Item -ItemType Directory -Force -Path $Backup | Out-Null
  Copy-Item "$State\*" $Backup -Recurse -Force -ErrorAction SilentlyContinue
  $n = (Get-ChildItem $Backup -Recurse -File).Count
  Write-Host "==> preserved $n state file(s) -> $Backup" -ForegroundColor Green
} elseif ($Fresh) {
  Write-Host "==> -Fresh: pairing will NOT be preserved. Reset the connector's key in Settings -> Connectors afterwards." -ForegroundColor Yellow
}

# ---- uninstall -------------------------------------------------------------
$keys = @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
          'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')
$installed = Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*OpenPrintHQ*' }
foreach ($app in $installed) {
  Write-Host "==> uninstalling $($app.DisplayName) v$($app.DisplayVersion)"
  $p = Start-Process msiexec.exe -ArgumentList "/x $($app.PSChildName) /qn /norestart" -Wait -PassThru
  if ($p.ExitCode -notin 0,1605,3010) { throw "uninstall failed ($($p.ExitCode))" }
}
if (-not $installed) { Write-Host "==> nothing installed to remove" }

# ---- install ---------------------------------------------------------------
Write-Host "==> installing"
$log = Join-Path $env:TEMP 'ophq-install.log'
$p = Start-Process msiexec.exe -ArgumentList "/i `"$Msi`" /qn /norestart /l*v `"$log`"" -Wait -PassThru
if ($p.ExitCode -notin 0,3010) { throw "install failed ($($p.ExitCode)) -- see $log" }

# ---- restore pairing -------------------------------------------------------
if (-not $Fresh -and (Test-Path $Backup)) {
  New-Item -ItemType Directory -Force -Path $State | Out-Null
  Copy-Item "$Backup\*" $State -Recurse -Force
  Write-Host "==> restored pairing state" -ForegroundColor Green
}

$now = Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*OpenPrintHQ*' }
Write-Host "installed: $($now.DisplayName) v$($now.DisplayVersion)" -ForegroundColor Green
if (Test-Path "$State\connector-key.pem") { Write-Host "pairing key present -- the connector should reconnect without re-pairing" -ForegroundColor Green }
else { Write-Host "no pairing key -- this connector will pair fresh on first connect" -ForegroundColor Yellow }

if (-not $KeepRunning) {
  # Name it explicitly. The install dir also holds the bundled sidecars
  # (ffmpeg, go2rtc, ophq-node) and "first .exe found" picks ffmpeg, which
  # starts, prints usage and exits -- leaving nothing running while the script
  # cheerfully reports success.
  $exe = Join-Path "$env:PROGRAMFILES\OpenPrintHQ Cloud Client" 'openprinthq-cloud-client.exe'
  if (Test-Path $exe) {
    Write-Host "==> starting the client"
    Start-Process $exe
    Start-Sleep -Seconds 3
    if (Get-Process -Name 'openprinthq-cloud-client' -ErrorAction SilentlyContinue) {
      Write-Host "client is running" -ForegroundColor Green
    } else {
      Write-Host "client did not stay running -- start it from the Start menu and check its log" -ForegroundColor Yellow
    }
  } else {
    Write-Host "could not find openprinthq-cloud-client.exe -- start it from the Start menu" -ForegroundColor Yellow
  }
}
