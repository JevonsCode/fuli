# Fuli installer for Windows: checks Node.js, installs the CLI, then runs the setup wizard.
#   irm https://xn--8ovp9s.xn--m8txu.com/fuli/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$required = [version]'24.12.0'

$node = Get-Command node -ErrorAction SilentlyContinue
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $node -or -not $npm) {
  Write-Host "Fuli needs Node.js $($required.Major).$($required.Minor) or newer with npm."
  Write-Host 'Install it from https://nodejs.org (or: winget install OpenJS.NodeJS), then run this installer again.'
  return
}

$version = [version](& node -p 'process.versions.node')
if ($version -lt $required) {
  Write-Host "Fuli needs Node.js $($required.Major).$($required.Minor) or newer; this machine has $version."
  Write-Host 'Update from https://nodejs.org (or: winget upgrade OpenJS.NodeJS), then run this installer again.'
  return
}

Write-Host 'Installing fuli-context with npm...'
& npm install --global fuli-context@latest
if ($LASTEXITCODE -ne 0) { throw 'npm could not install fuli-context.' }

& fuli setup
