# FreshCatch app icons — graphite + sage fish, generated locally (no network).
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'
$iconDir = Join-Path $PSScriptRoot 'public\icons'
New-Item -ItemType Directory -Force -Path $iconDir | Out-Null

function Make-Icon([int]$size, [string]$path) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

    $bg    = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 0x1C, 0x1F, 0x23))
    $sage  = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 0x9C, 0xAF, 0x88))
    $deep  = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 0x7D, 0x8F, 0x69))
    $dark  = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 0x1C, 0x1F, 0x23))
    $penArgs = @([System.Drawing.Color]::FromArgb(255, 0x1C, 0x1F, 0x23), [float](2.6 * $size / 100.0))
    $pen   = New-Object -TypeName System.Drawing.Pen -ArgumentList $penArgs

    $g.FillRectangle($bg, 0, 0, $size, $size)

    $u = $size / 100.0
    # body
    $g.FillEllipse($sage, [float](14 * $u), [float](33 * $u), [float](54 * $u), [float](34 * $u))
    # tail
    $pts = @(
        (New-Object System.Drawing.PointF([float](64 * $u), [float](50 * $u))),
        (New-Object System.Drawing.PointF([float](88 * $u), [float](34 * $u))),
        (New-Object System.Drawing.PointF([float](88 * $u), [float](66 * $u)))
    )
    $g.FillPolygon($deep, $pts)
    # eye
    $g.FillEllipse($dark, [float](26 * $u), [float](41 * $u), [float](6.5 * $u), [float](6.5 * $u))
    # mouth curve
    $g.DrawArc($pen, [float](14 * $u), [float](48 * $u), [float](14 * $u), [float](10 * $u), 20, 90)

    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
    Write-Host "wrote $path"
}

Make-Icon 192 (Join-Path $iconDir 'icon-192.png')
Make-Icon 512 (Join-Path $iconDir 'icon-512.png')
