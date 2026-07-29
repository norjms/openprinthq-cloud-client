# SPDX-License-Identifier: AGPL-3.0-or-later
# Fetch the Node runtime and place it as the Tauri sidecar (Windows).
# Used by CI so the MSI bundles Node (goal: no CLI installs).
#
#   powershell -ExecutionPolicy Bypass -File scripts\fetch-node.ps1 `
#       -Triple x86_64-pc-windows-msvc -OutDir app\src-tauri\binaries

param(
  [string]$Triple = "x86_64-pc-windows-msvc",
  [string]$OutDir = "app\src-tauri\binaries",
  [string]$NodeVersion = $(if ($env:NODE_VERSION) { $env:NODE_VERSION } else { "v22.11.0" })
)

$ErrorActionPreference = "Stop"

switch ($Triple) {
  "x86_64-pc-windows-msvc" { $plat = "win-x64" }
  "aarch64-pc-windows-msvc" { $plat = "win-arm64" }
  default { throw "unsupported triple: $Triple" }
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$pkg = "node-$NodeVersion-$plat"
$url = "https://nodejs.org/dist/$NodeVersion/$pkg.zip"
$tmp = Join-Path $env:TEMP ("nodefetch-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$zip = Join-Path $tmp "node.zip"

# Robust download. Windows PowerShell's Invoke-WebRequest renders a byte-by-byte
# progress stream that makes a ~30 MB download crawl (and sometimes stall for
# minutes) in non-interactive shells. Prefer curl.exe (ships with Windows 10
# 1803+), and only fall back to Invoke-WebRequest with the progress UI disabled.
function Get-File($src, $dst) {
  $curl = (Get-Command curl.exe -ErrorAction SilentlyContinue)
  for ($i = 1; $i -le 3; $i++) {
    try {
      if ($curl) {
        & curl.exe -fL --retry 3 --retry-delay 2 --connect-timeout 20 -o $dst $src
        if ($LASTEXITCODE -eq 0 -and (Test-Path $dst) -and (Get-Item $dst).Length -gt 1mb) { return }
      } else {
        $old = $ProgressPreference; $ProgressPreference = "SilentlyContinue"
        try { Invoke-WebRequest -Uri $src -OutFile $dst -UseBasicParsing } finally { $ProgressPreference = $old }
        if ((Test-Path $dst) -and (Get-Item $dst).Length -gt 1mb) { return }
      }
    } catch { Write-Host "  download attempt $i failed: $($_.Exception.Message)" }
    Start-Sleep -Seconds 3
  }
  throw "could not download $src after 3 attempts"
}

try {
  Write-Host "Downloading $url"
  Get-File $url $zip
  Write-Host ("  got {0:N1} MB" -f ((Get-Item $zip).Length / 1mb))
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $dest = Join-Path $OutDir "ophq-node-$Triple.exe"
  Copy-Item -Force "$tmp\$pkg\node.exe" $dest
  if (-not (Test-Path $dest)) { throw "sidecar not placed at $dest" }
  Write-Host "Placed sidecar: $dest"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
