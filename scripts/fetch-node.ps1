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
try {
  Write-Host "Downloading $url"
  Invoke-WebRequest -Uri $url -OutFile "$tmp\node.zip"
  Expand-Archive -Path "$tmp\node.zip" -DestinationPath $tmp -Force
  $dest = Join-Path $OutDir "node-$Triple.exe"
  Copy-Item -Force "$tmp\$pkg\node.exe" $dest
  Write-Host "Placed sidecar: $dest"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
