import { execFileSync } from 'node:child_process';
import { dirname, join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isDesktopAppPackage } from './desktop-app-package.js';
import { readWindowsInstallation } from './windows-installation-context.js';

// Whether this installation's FULI desktop client opens `fuli://` links, so
// the console in a browser can offer 「在客户端打开」. On Windows the client
// registers the scheme for its user once it runs
// (desktop/flutter windows_url_scheme.dart); the scheme must start this
// installation's launcher, checked at most once a minute. On macOS the app
// declares the scheme itself (Info.plist), so its own package is enough.
// Anything else, or anything unexpected, answers false.

const COMMAND_KEY = 'HKCU\\Software\\Classes\\fuli\\shell\\open\\command';
const RECHECK_MS = 60_000;
const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export function desktopClientOpensLinks({ platform = process.platform, packageRoot = PACKAGE_ROOT,
  readInstallation = readWindowsInstallation, readCommand = readSchemeCommand,
  isAppPackage = isDesktopAppPackage, now = Date.now } = {}) {
  if (platform === 'darwin') {
    const opens = isAppPackage(packageRoot, { platform });
    return () => opens;
  }
  if (platform !== 'win32') return () => false;
  let installRoot;
  try { installRoot = readInstallation(packageRoot)?.installRoot ?? null; } catch { installRoot = null; }
  if (!installRoot) return () => false;
  let checkedAt = -Infinity;
  let opens = false;
  return () => {
    if (now() - checkedAt >= RECHECK_MS) {
      checkedAt = now();
      opens = opensInstallation(readCommand(), installRoot);
    }
    return opens;
  };
}

// The command must start a version's root launcher: <installRoot>\versions\<id>\Fuli.exe.
function opensInstallation(command, installRoot) {
  const launcher = typeof command === 'string' ? /^\s*"([^"]+)"/.exec(command)?.[1] : null;
  if (!launcher || win32.basename(launcher).toLowerCase() !== 'fuli.exe') return false;
  const versions = win32.dirname(win32.dirname(launcher));
  return win32.relative(win32.join(installRoot, 'versions'), versions) === '';
}

// The scheme's open command, or null. `reg query /ve` names the default value
// in the system language, so only its type and data are read.
function readSchemeCommand() {
  try {
    const out = execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe'),
      ['query', COMMAND_KEY, '/ve'], { encoding: 'utf8', windowsHide: true, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
    return /REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}
