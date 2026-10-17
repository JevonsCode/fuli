# Fuli installer for Windows: uses an existing Node.js >= 24.12 or provisions
# a standalone SHA-256-verified Node.js 24.18.0 runtime, installs the CLI, and runs fuli setup.
#   irm https://xn--8ovp9s.xn--m8txu.com/fuli/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$required = [version]'24.12.0'
$standaloneVersion = '24.18.0'
$standaloneChecksums = @{
  'win-x64'   = '0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821'
  'win-arm64' = 'f274669adb93b1fd0fbf8f21fd078609e9dcc84333d4f2718d2dde3f9a161a01'
}

function Test-FuliNodeVersion {
  $node = Get-Command node -ErrorAction SilentlyContinue
  $npm = Get-Command npm -ErrorAction SilentlyContinue
  if (-not $node -or -not $npm) { return $false }
  try {
    $current = [version](& node -p 'process.versions.node')
    return ($current -ge $required)
  } catch {
    return $false
  }
}

function Use-FuliStandaloneNode {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'win-arm64' } else { 'win-x64' }
  $expectedSha = if ($env:FULI_NODE_SHA256) { $env:FULI_NODE_SHA256.ToLowerInvariant() } else { $standaloneChecksums[$arch] }
  $baseRuntime = if ($env:FULI_RUNTIME_HOME) { $env:FULI_RUNTIME_HOME } else { Join-Path $env:LOCALAPPDATA 'Fuli\runtime' }
  $distName = "node-v$standaloneVersion-$arch"
  $nodeRoot = Join-Path $baseRuntime $distName
  $prefixRoot = Join-Path $baseRuntime 'prefix'
  $nodeExe = Join-Path $nodeRoot 'node.exe'

  if (-not (Test-Path $nodeExe)) {
    New-Item -ItemType Directory -Force -Path $baseRuntime | Out-Null
    $tmpArchive = Join-Path $baseRuntime "$distName-$PID.zip"
    if ($env:FULI_NODE_ARCHIVE_PATH) {
      Copy-Item -LiteralPath $env:FULI_NODE_ARCHIVE_PATH -Destination $tmpArchive -Force
    } else {
      $baseUrl = if ($env:FULI_NODE_DIST_BASE_URL) { $env:FULI_NODE_DIST_BASE_URL } else { "https://nodejs.org/dist/v$standaloneVersion" }
      $archiveUrl = "$baseUrl/$distName.zip"
      Write-Host "Downloading standalone Node.js v$standaloneVersion ($arch)..."
      Invoke-WebRequest -Uri $archiveUrl -OutFile $tmpArchive -UseBasicParsing
    }
    $actualSha = (Get-FileHash -LiteralPath $tmpArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualSha -ne $expectedSha) {
      Remove-Item -LiteralPath $tmpArchive -Force -ErrorAction SilentlyContinue
      throw "Standalone Node.js checksum mismatch for $distName.zip (expected $expectedSha, got $actualSha)."
    }
    Expand-Archive -LiteralPath $tmpArchive -DestinationPath $baseRuntime -Force
    Remove-Item -LiteralPath $tmpArchive -Force -ErrorAction SilentlyContinue
  }

  New-Item -ItemType Directory -Force -Path $prefixRoot | Out-Null
  $env:NPM_CONFIG_PREFIX = $prefixRoot
  $env:PATH = "$prefixRoot;$nodeRoot;$env:PATH"
}

$useStandalone = ($env:FULI_USE_STANDALONE_NODE -eq '1') -or (-not (Test-FuliNodeVersion))
if ($useStandalone) {
  if ($env:FULI_NO_STANDALONE_NODE -eq '1') {
    $node = Get-Command node -ErrorAction SilentlyContinue
    $currentVersion = if ($node) { & node -p 'process.versions.node' } else { 'missing' }
    Write-Host "Fuli needs Node.js $($required.Major).$($required.Minor) or newer; this machine has $currentVersion."
    Write-Host 'Update from https://nodejs.org (or: winget upgrade OpenJS.NodeJS), then run this installer again.'
    return
  }
  Use-FuliStandaloneNode
}

Write-Host 'Installing fuli-context with npm...'
& npm install --global fuli-context@latest
if ($LASTEXITCODE -ne 0) { throw 'npm could not install fuli-context.' }

& fuli setup @args
