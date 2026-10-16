import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const installationSha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function canonicalWindowsInstallPath(path) {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  if (parent === absolute) throw new Error('Cannot resolve the installation directory.');
  return resolve(canonicalWindowsInstallPath(parent), relative(parent, absolute));
}

export function windowsInstallPathsOverlap(a, b) {
  const contains = (root, path) => !isAbsolute(relative(root, path)) && relative(root, path).split(/[\\/]/)[0] !== '..';
  return contains(a, b) || contains(b, a);
}

// A candidate cannot opt into daily data by changing its kind. Only a matching
// registration outside the package, at the registered slot, binds installed data.
export function readWindowsInstallation(packageRoot) {
  const root = canonicalWindowsInstallPath(packageRoot);
  const receiptPath = join(root, 'installed-context.json');
  if (!existsSync(receiptPath)) return null;
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const fail = () => { throw new Error('Invalid Windows installation record; do not move an installed application directory.'); };
  if (receipt.version !== 1 || receipt.kind !== 'windows-user-installation'
      || !/^[a-f0-9-]{36}$/.test(receipt.installationId ?? '')
      || !['installRoot', 'packageRoot', 'dataDir'].every(key => typeof receipt[key] === 'string' && isAbsolute(receipt[key]))) fail();
  const installRoot = canonicalWindowsInstallPath(receipt.installRoot);
  const dataDir = canonicalWindowsInstallPath(receipt.dataDir);
  if (root !== canonicalWindowsInstallPath(receipt.packageRoot)
      || root !== canonicalWindowsInstallPath(join(installRoot, 'versions', receipt.installationId))
      || windowsInstallPathsOverlap(installRoot, dataDir)) fail();
  const record = JSON.parse(readFileSync(join(installRoot, 'installation.json'), 'utf8'));
  if (record.status !== 'installed' || ['version', 'kind', 'installationId', 'installRoot', 'packageRoot', 'dataDir', 'inventorySha256']
    .some(key => record[key] !== receipt[key])
      || record.applicationVersion !== JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
      || !Array.isArray(record.shortcuts) || record.shortcuts.length !== 2 || !record.shortcuts.every(path => typeof path === 'string' && isAbsolute(path))
      || receipt.inventorySha256 !== installationSha256(readFileSync(join(root, 'tray-files.sha256.json')))) fail();
  return record;
}
