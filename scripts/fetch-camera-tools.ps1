# SPDX-License-Identifier: AGPL-3.0-or-later
# Fetch go2rtc + ffmpeg and place them as Tauri sidecars (Windows), so the MSI
# bundles them and the connector can relay printer cameras with no manual install.
#
# Camera relay architecture credit: OctoEverywhere by Quinn Damerell
# (https://github.com/QuinnDamerell/OctoPrint-OctoEverywhere, AGPL-3.0).
#
#   powershell -ExecutionPolicy Bypass -File scripts\fetch-camera-tools.ps1 `
#       -Triple x86_64-pc-windows-msvc -OutDir app\src-tauri\binaries

param(
  [string]$Triple = "x86_64-pc-windows-msvc",
  [string]$OutDir = "app\src-tauri\binaries",
  [string]$Go2rtcVersion = $(if ($env:GO2RTC_VERSION) { $env:GO2RTC_VERSION } else { "1.9.9" })
)

$ErrorActionPreference = "Stop"

switch ($Triple) {
  "x86_64-pc-windows-msvc"  { $g2arch = "win64"; $ffArch = "win64" }
  "aarch64-pc-windows-msvc" { $g2arch = "win_arm64"; $ffArch = "winarm64" }
  default { throw "unsupported triple: $Triple" }
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$tmp = Join-Path $env:TEMP ("camfetch-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

function Get-File($src, $dst) {
  $curl = (Get-Command curl.exe -ErrorAction SilentlyContinue)
  for ($i = 1; $i -le 3; $i++) {
    try {
      if ($curl) {
        # curl writes progress to stderr and PowerShell treats native stderr as a
        # terminating error, so a good download looked like a failure.
        & curl.exe -fL --no-progress-meter --retry 3 --retry-delay 2 --connect-timeout 20 -o $dst $src 2>$null
        if ($LASTEXITCODE -eq 0 -and (Test-Path $dst) -and (Get-Item $dst).Length -gt 500kb) { return }
      } else {
        $ProgressPreference = "SilentlyContinue"
        Invoke-WebRequest -Uri $src -OutFile $dst -UseBasicParsing
        if ((Test-Path $dst) -and (Get-Item $dst).Length -gt 500kb) { return }
      }
    } catch { Start-Sleep -Seconds 2 }
  }
  throw "download failed: $src"
}

# --- go2rtc (single static exe) ---
$g2url = "https://github.com/AlexxIT/go2rtc/releases/download/v$Go2rtcVersion/go2rtc_$g2arch.zip"
$g2zip = Join-Path $tmp "go2rtc.zip"
Get-File $g2url $g2zip
Expand-Archive -Path $g2zip -DestinationPath $tmp -Force
$g2exe = Get-ChildItem -Path $tmp -Recurse -Filter "go2rtc*.exe" | Select-Object -First 1
if (-not $g2exe) { throw "go2rtc.exe not found in archive" }
# Tauri sidecars are named with the target triple suffix.
Copy-Item $g2exe.FullName (Join-Path $OutDir "go2rtc-$Triple.exe") -Force

# --- ffmpeg (used by go2rtc for RTSPS->MJPEG transcode) ---
$ffurl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-$ffArch-gpl.zip"
$ffzip = Join-Path $tmp "ffmpeg.zip"
Get-File $ffurl $ffzip
Expand-Archive -Path $ffzip -DestinationPath $tmp -Force
$ffexe = Get-ChildItem -Path $tmp -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
if (-not $ffexe) { throw "ffmpeg.exe not found in archive" }
Copy-Item $ffexe.FullName (Join-Path $OutDir "ffmpeg-$Triple.exe") -Force

Write-Host "Fetched camera sidecars: go2rtc-$Triple.exe, ffmpeg-$Triple.exe -> $OutDir"
Get-ChildItem $OutDir | Select-Object Name,Length | Format-Table -AutoSize
