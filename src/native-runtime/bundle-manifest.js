import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

// native-bundle.json at a package root: the runtime a Windows package or the
// macOS app ships beside FULI (windows-assets.js, macos-assets.js). Every
// path in it is relative to the package and stays inside it.

export function readBundleManifest(packageRoot) {
  const path = join(packageRoot, 'native-bundle.json');
  if (!existsSync(path)) return null;
  return { manifest: JSON.parse(readFileSync(path, 'utf8')), root: realpathSync(packageRoot) };
}

export function bundlePath(root, value, key) {
  if (typeof value !== 'string' || !value.trim() || isAbsolute(value)) {
    throw new Error('Portable bundle paths must be relative: ' + key);
  }
  const resolved = resolve(root, value);
  const local = relative(root, resolved);
  if (!local || local.startsWith('..') || isAbsolute(local)) {
    throw new Error('Portable bundle paths must stay inside the bundle: ' + key);
  }
  return resolved;
}
