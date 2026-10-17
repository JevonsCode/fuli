#!/bin/sh
# Fuli installer for macOS and Linux: uses an existing Node.js >= 24.12 or provisions
# a standalone SHA-256-verified Node.js 24.18.0 runtime, installs the CLI, and runs fuli setup.
#   curl -fsSL https://xn--8ovp9s.xn--m8txu.com/fuli/install.sh | sh
set -eu

REQUIRED_MAJOR=24
REQUIRED_MINOR=12
STANDALONE_NODE_VERSION=24.18.0

node_meets_minimum() {
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    return 1
  fi
  version=$(node -p 'process.versions.node' 2>/dev/null || echo 0.0.0)
  major=${version%%.*}
  rest=${version#*.}
  minor=${rest%%.*}
  if [ "$major" -lt "$REQUIRED_MAJOR" ] || { [ "$major" -eq "$REQUIRED_MAJOR" ] && [ "$minor" -lt "$REQUIRED_MINOR" ]; }; then
    return 1
  fi
  return 0
}

standalone_node_target() {
  os_name=$(uname -s)
  arch_name=$(uname -m)
  case "$os_name" in
    Darwin) platform="darwin" ;;
    Linux) platform="linux" ;;
    *)
      echo "Unsupported OS for standalone Node.js runtime: $os_name" >&2
      return 1
      ;;
  esac
  case "$arch_name" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64) arch="x64" ;;
    *)
      echo "Unsupported architecture for standalone Node.js runtime: $arch_name" >&2
      return 1
      ;;
  esac
  printf '%s-%s' "$platform" "$arch"
}

standalone_node_sha256() {
  if [ -n "${FULI_NODE_SHA256:-}" ]; then
    printf '%s' "$FULI_NODE_SHA256"
    return 0
  fi
  case "$1" in
    darwin-arm64) printf 'e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1' ;;
    darwin-x64)   printf 'dfd0dbd3e721503434df7b7205e719f61b3a3a31b2bcf9729b8b91fea240f080' ;;
    linux-arm64)  printf '6b4484c2190274175df9aa8f28e2d758a819cb1c1fe6ab481e2f95b463ab8508' ;;
    linux-x64)    printf '783130984963db7ba9cbd01089eaf2c2efb055c7c1693c943174b967b3050cb8' ;;
    *) return 1 ;;
  esac
}

compute_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    echo "Could not find sha256sum, shasum, or openssl to verify Node.js archive." >&2
    return 1
  fi
}

provision_standalone_node() {
  target=$(standalone_node_target)
  expected_sha=$(standalone_node_sha256 "$target")
  runtime_home=${FULI_RUNTIME_HOME:-"${XDG_DATA_HOME:-$HOME/.local/share}/fuli/runtime"}
  dist_name="node-v${STANDALONE_NODE_VERSION}-${target}"
  node_root="${runtime_home}/${dist_name}"
  prefix_root="${runtime_home}/prefix"

  if [ ! -x "${node_root}/bin/node" ]; then
    mkdir -p "$runtime_home"
    tmp_archive="${runtime_home}/${dist_name}.tar.gz.$$"
    if [ -n "${FULI_NODE_ARCHIVE_PATH:-}" ]; then
      cp "$FULI_NODE_ARCHIVE_PATH" "$tmp_archive"
    else
      base_url=${FULI_NODE_DIST_BASE_URL:-"https://nodejs.org/dist/v${STANDALONE_NODE_VERSION}"}
      archive_url="${base_url}/${dist_name}.tar.gz"
      echo "Downloading standalone Node.js v${STANDALONE_NODE_VERSION} (${target})..."
      curl -fsSL "$archive_url" -o "$tmp_archive"
    fi
    actual_sha=$(compute_sha256 "$tmp_archive")
    if [ "$actual_sha" != "$expected_sha" ]; then
      rm -f "$tmp_archive"
      echo "Standalone Node.js checksum mismatch for ${dist_name}.tar.gz (expected ${expected_sha}, got ${actual_sha})." >&2
      exit 1
    fi
    tar -xzf "$tmp_archive" -C "$runtime_home"
    rm -f "$tmp_archive"
  fi

  mkdir -p "${prefix_root}/bin"
  export NPM_CONFIG_PREFIX="$prefix_root"
  export PATH="${prefix_root}/bin:${node_root}/bin:${PATH}"
}

if [ "${FULI_USE_STANDALONE_NODE:-0}" = "1" ] || ! node_meets_minimum; then
  if [ "${FULI_NO_STANDALONE_NODE:-0}" = "1" ]; then
    current_version=$(node -p 'process.versions.node' 2>/dev/null || echo "missing")
    echo "Fuli needs Node.js ${REQUIRED_MAJOR}.${REQUIRED_MINOR} or newer; this machine has ${current_version}."
    echo "Update from https://nodejs.org (or with fnm / nvm), then run this installer again."
    exit 1
  fi
  provision_standalone_node
fi

echo "Installing fuli-context with npm..."
npm install --global fuli-context@latest

# The wizard asks before changing anything; reconnect stdin so it can when piped from curl.
if [ -t 1 ] && [ -r /dev/tty ]; then
  fuli setup "$@" < /dev/tty
else
  fuli setup "$@"
fi
