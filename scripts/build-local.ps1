# Native Windows build. Produces the same MSI the release workflow does, without
# needing GitHub Actions — which matters when Actions is degraded, and for
# testing a change before tagging it.
#
#   pwsh -File scripts\build-local.ps1              # version from tauri.conf.json
#   pwsh -File scripts\build-local.ps1 -Version 0.0.9
#
# Requires: Rust, Node, and cargo-tauri (cargo install tauri-cli --version "^2.0").
[CmdletBinding()]
param([string]$Version, [switch]$SkipFetch)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$conf = "$root\app\src-tauri\tauri.conf.json"

foreach ($t in 'cargo','node','cargo-tauri') {
  if (-not (Get-Command $t -ErrorAction SilentlyContinue)) {
    throw "$t not found. Install Rust + Node, then: cargo install tauri-cli --version `"^2.0`""
  }
}

if ($Version) {
  # Keep every version marker in step, exactly as the release workflow does.
  (Get-Content $conf -Raw) -replace '"version":\s*"[^"]+"', "`"version`": `"$Version`"" | Set-Content $conf -NoNewline
  $ct = "$root\app\src-tauri\Cargo.toml"
  (Get-Content $ct -Raw) -replace '(?m)^version\s*=\s*"[^"]+"', "version = `"$Version`"" | Set-Content $ct -NoNewline
  $pj = "$root\agent\package.json"
  (Get-Content $pj -Raw) -replace '"version":\s*"[^"]+"', "`"version`": `"$Version`"" | Set-Content $pj -NoNewline
}
$ver = (Get-Content $conf -Raw | ConvertFrom-Json).version
Write-Host "building OpenPrintHQ Cloud Client $ver (windows x86_64)" -ForegroundColor Cyan

if (-not $SkipFetch) {
  Write-Host "==> fetching bundled Node sidecar"
  & "$root\scripts\fetch-node.ps1" -Triple x86_64-pc-windows-msvc -OutDir app/src-tauri/binaries
  Write-Host "==> fetching camera sidecars (go2rtc + ffmpeg)"
  & "$root\scripts\fetch-camera-tools.ps1" -Triple x86_64-pc-windows-msvc -OutDir app/src-tauri/binaries
}

Write-Host "==> cargo tauri build"
Push-Location "$root\app"
try { & cargo tauri build --bundles msi; if ($LASTEXITCODE -ne 0) { throw "tauri build failed ($LASTEXITCODE)" } }
finally { Pop-Location }

$out = "$root\dist"
New-Item -ItemType Directory -Force -Path $out | Out-Null
Get-ChildItem "$root\app\src-tauri\target\release\bundle\msi" -Filter *.msi |
  ForEach-Object { Copy-Item $_.FullName $out -Force; "  {0}  {1:N1} MB" -f $_.Name, ($_.Length/1MB) }
Write-Host "artifacts in $out" -ForegroundColor Green
