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

const UNUSABLE_RECORD = 'FULI 的安装记录读不出来，或程序文件夹被移动过。请重新安装 FULI，数据文件夹不受影响。'
  + ' / FULI\'s installation record can\'t be read, or its program folder was moved. Reinstall FULI; your data folder is kept.';

// A version kept for rollback (or one an update replaced while it ran) after
// the installation moved on: its own receipt is intact, but installation.json
// names another version of the same installation and data. installation is
// that record; its packageRoot is the copy to open instead.
export class WindowsInstallationSupersededError extends Error {
  constructor(installation) {
    super('这是旧版本的 FULI，新版本已经装好了。请从开始菜单或桌面打开 FULI。'
      + ' / This is an older version of FULI; the new one is installed. Open FULI from the Start menu or Desktop.');
    this.code = 'installation_superseded';
    this.installation = installation;
  }
}

// A candidate cannot opt into daily data by changing its kind. Only a matching
// registration outside the package, at the registered slot, binds installed data.
export function readWindowsInstallation(packageRoot) {
  const root = canonicalWindowsInstallPath(packageRoot);
  const receiptPath = join(root, 'installed-context.json');
  if (!existsSync(receiptPath)) return null;
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const fail = () => { throw new Error(UNUSABLE_RECORD); };
  if (receipt.version !== 1 || receipt.kind !== 'windows-user-installation'
      || !/^[a-f0-9-]{36}$/.test(receipt.installationId ?? '')
      || !['installRoot', 'packageRoot', 'dataDir'].every(key => typeof receipt[key] === 'string' && isAbsolute(receipt[key]))) fail();
  const installRoot = canonicalWindowsInstallPath(receipt.installRoot);
  const dataDir = canonicalWindowsInstallPath(receipt.dataDir);
  if (root !== canonicalWindowsInstallPath(receipt.packageRoot)
      || root !== canonicalWindowsInstallPath(join(installRoot, 'versions', receipt.installationId))
      || windowsInstallPathsOverlap(installRoot, dataDir)) fail();
  const record = JSON.parse(readFileSync(join(installRoot, 'installation.json'), 'utf8'));
  if (supersedes(record, receipt)) throw new WindowsInstallationSupersededError(record);
  if (record.status !== 'installed' ||['version', 'kind', 'installationId', 'installRoot', 'packageRoot', 'dataDir', 'inventorySha256']
    .some(key => record[key] !== receipt[key])
      || record.applicationVersion !== JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
      || !Array.isArray(record.shortcuts) || record.shortcuts.length !== 2 || !record.shortcuts.every(path => typeof path === 'string' && isAbsolute(path))
      || receipt.inventorySha256 !== installationSha256(readFileSync(join(root, 'tray-files.sha256.json')))) fail();
  return record;
}

// The record names another installed version of this installation and its data.
function supersedes(record, receipt) {
  return record.status === 'installed' && record.kind === receipt.kind && /^[a-f0-9-]{36}$/.test(record.installationId ?? '')
    && record.installationId !== receipt.installationId && record.installRoot === receipt.installRoot
    && record.dataDir === receipt.dataDir
    && record.packageRoot === join(receipt.installRoot, 'versions', record.installationId);
}

// What an installed package runs to move adopted container data to native.
export function windowsMigrationCommand(packageRoot) {
  return '"' + join(packageRoot, 'runtime', 'node', 'node.exe') + '" "' + join(packageRoot, 'src', 'cli.js')
    + '" graph migrate --to native';
}
