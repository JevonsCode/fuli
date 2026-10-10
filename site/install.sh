#!/bin/sh
# Fuli installer for macOS and Linux: checks Node.js, installs the CLI, then runs the setup wizard.
#   curl -fsSL https://xn--8ovp9s.xn--m8txu.com/fuli/install.sh | sh
set -eu

REQUIRED_MAJOR=24
REQUIRED_MINOR=12

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Fuli needs Node.js ${REQUIRED_MAJOR}.${REQUIRED_MINOR} or newer with npm."
  echo "Install it from https://nodejs.org (or with fnm / nvm), then run this installer again."
  exit 1
fi

version=$(node -p 'process.versions.node')
major=${version%%.*}
rest=${version#*.}
minor=${rest%%.*}
if [ "$major" -lt "$REQUIRED_MAJOR" ] || { [ "$major" -eq "$REQUIRED_MAJOR" ] && [ "$minor" -lt "$REQUIRED_MINOR" ]; }; then
  echo "Fuli needs Node.js ${REQUIRED_MAJOR}.${REQUIRED_MINOR} or newer; this machine has ${version}."
  echo "Update from https://nodejs.org (or with fnm / nvm), then run this installer again."
  exit 1
fi

echo "Installing fuli-context with npm..."
npm install --global fuli-context@latest

# The wizard asks before changing anything; reconnect stdin so it can when piped from curl.
if [ -t 1 ] && [ -r /dev/tty ]; then
  fuli setup < /dev/tty
else
  fuli setup
fi
