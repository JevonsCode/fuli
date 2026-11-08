import { realpathSync } from 'node:fs';

import { readMacosNativeBundle } from '../native-runtime/macos-assets.js';
import { readWindowsNativeBundle } from '../native-runtime/windows-assets.js';

// Whether a FULI package is the desktop client's own copy: the package inside
// FULI.app on macOS, or a Windows package that carries its native bundle
// (installed or the portable tray). An npm installation or a source checkout
// is neither.
const MACOS_APP_PACKAGE = /\.app\/Contents\/Resources\/fuli\/?$/;

export const isMacosAppPackage = (packageRoot) => MACOS_APP_PACKAGE.test(String(packageRoot).replaceAll('\\', '/'));

export function isDesktopAppPackage(packageRoot, { platform = process.platform } = {}) {
  if (typeof packageRoot !== 'string' || !packageRoot) return false;
  try {
    if (platform === 'win32') return readWindowsNativeBundle(packageRoot) !== null;
    return platform === 'darwin' && isMacosAppPackage(packageRoot) && readMacosNativeBundle(packageRoot) !== null;
  } catch {
    return false;
  }
}

// Whether two package roots name the same folder, followed through links;
// Windows paths compare without case.
export function samePackageRoot(a, b, { platform = process.platform } = {}) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const real = (path) => { try { return realpathSync(path); } catch { return path; } };
  const [left, right] = [real(a), real(b)].map((path) => path.replace(/[\\/]+$/, ''));
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
