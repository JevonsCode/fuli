import { execFileSync } from 'node:child_process';
import { dirname, join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readWindowsInstallation } from './windows-installation-context.js';

// Receipt links as `fuli://` links (rec#11 D-80): the FULI desktop client of
// this Windows installation registers the scheme for its user
// (desktop/flutter windows_url_scheme.dart), opens the page with whatever port
// the console uses now, and only navigates. Until the scheme opens this
// installation's launcher, receipts keep their http links. Checked at most
// once a minute; anything unexpected also keeps http links.

const COMMAND_KEY = 'HKCU\\Software\\Classes\\fuli\\shell\\open\\command';
const RECHECK_MS = 60_000;
const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// `fuli:/` + `/settings` is `fuli://settings`, the form the client reads.
export const FULI_LINK_ORIGIN = 'fuli:/';

export function fuliLinkOrigin({ platform = process.platform, packageRoot = PACKAGE_ROOT,
  readInstallation = readWindowsInstallation, readCommand = readSchemeCommand, now = Date.now } = {}) {
  if (platform !== 'win32') return () => null;
  let installRoot;
  try { installRoot = readInstallation(packageRoot)?.installRoot ?? null; } catch { installRoot = null; }
  if (!installRoot) return () => null;
  let checkedAt = -Infinity;
  let origin = null;
  return () => {
    if (now() - checkedAt >= RECHECK_MS) {
      checkedAt = now();
      origin = opensInstallation(readCommand(), installRoot) ? FULI_LINK_ORIGIN : null;
    }
    return origin;
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
