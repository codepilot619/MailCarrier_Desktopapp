const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const desktopRoot = path.join(__dirname, "..");
const repoRoot = path.join(desktopRoot, "..");
const buildDir = path.join(desktopRoot, "build");
const sourcePng = path.join(repoRoot, "icons", "mail-carrier-128.png");
const iconPng = path.join(buildDir, "icon.png");
const iconIco = path.join(buildDir, "icon.ico");

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

copyFile(
  path.join(repoRoot, "shared", "email-content.js"),
  path.join(desktopRoot, "shared", "email-content.js"),
);
copyFile(sourcePng, path.join(desktopRoot, "icons", "mail-carrier-128.png"));
fs.mkdirSync(buildDir, { recursive: true });

const psPath = path.join(buildDir, "make-icon.ps1");
fs.writeFileSync(psPath, `
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile($env:MAIL_CARRIER_SOURCE_PNG)
$bmp = New-Object System.Drawing.Bitmap 256, 256
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::Transparent)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, 256, 256))
$g.Dispose()
$src.Dispose()
$pngStream = New-Object System.IO.MemoryStream
$bmp.Save($pngStream, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$pngBytes = $pngStream.ToArray()
$pngStream.Dispose()
[System.IO.File]::WriteAllBytes($env:MAIL_CARRIER_ICON_PNG, $pngBytes)
$ico = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter $ico
$writer.Write([UInt16]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]1)
$writer.Write([byte]0)
$writer.Write([byte]0)
$writer.Write([byte]0)
$writer.Write([byte]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]32)
$writer.Write([UInt32]$pngBytes.Length)
$writer.Write([UInt32]22)
$writer.Write($pngBytes)
$writer.Flush()
[System.IO.File]::WriteAllBytes($env:MAIL_CARRIER_ICON_ICO, $ico.ToArray())
$writer.Dispose()
$ico.Dispose()
`);

execFileSync("powershell.exe", ["-NoProfile", "-File", psPath], {
  stdio: "inherit",
  env: {
    ...process.env,
    MAIL_CARRIER_SOURCE_PNG: sourcePng,
    MAIL_CARRIER_ICON_PNG: iconPng,
    MAIL_CARRIER_ICON_ICO: iconIco,
  },
});

console.log("Staged Mail Carrier installer assets.");
