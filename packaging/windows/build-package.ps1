# Package FULI NEXT native Windows x64 portable bundle (fuli-context + fuli + fuli-ui).
# Usage: pwsh -File packaging/windows/build-package.ps1 [-Version "1.0.0-next.0"] [-OutDir "dist-next"]
param(
    [string]$Version = "1.0.0-next.0",
    [string]$OutDir = "dist-next"
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$relDir   = Join-Path $repoRoot "target\release"
$stageDir = Join-Path $repoRoot "$OutDir\FULI-windows-x64"
$zipPath  = Join-Path $repoRoot "$OutDir\FULI-$Version-windows-x64.zip"

foreach ($bin in @("fuli-context.exe", "fuli.exe", "fuli-ui.exe")) {
    $p = Join-Path $relDir $bin
    if (-not (Test-Path $p)) {
        throw "Missing release binary $p — run 'cargo build --release --workspace' first."
    }
}

if (Test-Path $stageDir) { Remove-Item -Recurse -Force $stageDir }
New-Item -ItemType Directory -Force -Path $stageDir | Out-Null

Copy-Item (Join-Path $relDir "fuli-context.exe") $stageDir
Copy-Item (Join-Path $relDir "fuli.exe")         $stageDir
Copy-Item (Join-Path $relDir "fuli-ui.exe")      $stageDir
Copy-Item (Join-Path $repoRoot "LICENSE")        $stageDir
if (Test-Path (Join-Path $repoRoot "brand\png\app-icon\fuli-app.ico")) {
    Copy-Item (Join-Path $repoRoot "brand\png\app-icon\fuli-app.ico") $stageDir
}

$readme = @"
FULI NEXT ($Version) — Pure Local Rust Edition
================================================
Make every collaboration compound.

Quick Start:
  1. Double-click or run `fuli-context.exe` (starts ultra-light ~10 MiB system tray daemon).
  2. Click the tray icon or run `fuli.exe open` to open the native GPUI desktop window.
  3. Run `fuli.exe doctor` to check health & detected AI clients.
  4. Connect your AI clients safely (creates .fuli.bak backup automatically):
       fuli.exe setup --client claude-code --apply
       fuli.exe setup --client codex --apply
       fuli.exe setup --client cursor --apply

Closing the desktop window exits `fuli-ui.exe` completely so GPU memory returns to 0 MiB.
"@
Set-Content -Path (Join-Path $stageDir "START-HERE.txt") -Value $readme -Encoding UTF8

if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
Compress-Archive -Path (Join-Path $stageDir "*") -DestinationPath $zipPath -CompressionLevel Optimal

$fi = Get-Item $zipPath
Write-Output ("Packaged Windows portable zip: {0} ({1:N2} MiB)" -f $fi.FullName, ($fi.Length / 1MB))
