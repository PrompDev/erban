# Build a multi-resolution Windows .ico from the Erban red logo (apple-touch-icon.png).
# Embeds PNG-compressed frames (16..256) so the taskbar/Start menu render crisply at any size.
#
# Usage: powershell -ExecutionPolicy Bypass -File make-icon.ps1
param(
  [string]$Source = (Join-Path $PSScriptRoot "control-ui\apple-touch-icon.png"),
  [string]$OutIco = (Join-Path $env:LOCALAPPDATA "Erban\erban.ico")
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path $Source)) { throw "Logo source not found: $Source" }
New-Item -ItemType Directory -Force -Path (Split-Path $OutIco -Parent) | Out-Null

$src = [System.Drawing.Image]::FromFile($Source)
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$frames = @()
foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($src, 0, 0, $s, $s)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $frames += ,@{ size = $s; bytes = $ms.ToArray() }
}
$src.Dispose()

# Assemble the ICO container: ICONDIR (6) + ICONDIRENTRY*N (16 each) + PNG payloads.
$out = New-Object System.IO.MemoryStream
$bw  = New-Object System.IO.BinaryWriter $out
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$frames.Count)  # reserved, type=icon, count
$offset = 6 + (16 * $frames.Count)
foreach ($f in $frames) {
  $dim = if ($f.size -ge 256) { 0 } else { $f.size }   # 0 means 256 in the ICO spec
  $bw.Write([byte]$dim); $bw.Write([byte]$dim)          # width, height
  $bw.Write([byte]0); $bw.Write([byte]0)                # palette, reserved
  $bw.Write([uint16]1); $bw.Write([uint16]32)           # planes, bpp
  $bw.Write([uint32]$f.bytes.Length)                    # bytes in resource
  $bw.Write([uint32]$offset)                            # offset
  $offset += $f.bytes.Length
}
foreach ($f in $frames) { $bw.Write($f.bytes) }
$bw.Flush()
[System.IO.File]::WriteAllBytes($OutIco, $out.ToArray())
$bw.Dispose(); $out.Dispose()

"Wrote $OutIco ($([Math]::Round((Get-Item $OutIco).Length/1kb,1)) KB, frames: $($sizes -join ','))"
