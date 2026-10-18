import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { readWindowsNativeBundle, resolveWindowsNativeBundle } from '../native-runtime/windows-assets.js';
import { compareSemanticVersions } from '../semantic-version.js';
import { canonicalWindowsInstallPath, installationSha256, readWindowsInstallation, windowsInstallPathsOverlap } from './windows-installation-context.js';
import { createWindowsShortcut, readWindowsShortcut, trayInventory } from './windows-installation.js';
import { assertInstallationUnchanged, installedWindowsShortcuts, runInstalledCli, stageWindowsShortcuts, stopAndSwitchWindowsInstallation } from './windows-installation-switch.js';
import { acquireWindowsUpdateLock } from './windows-update-lock.js';
import { snapshotWindowsUpdateRuntime } from './windows-update-runtime.js';

// The registered installation under installRoot, its record bytes and shortcuts.
export function readCurrentWindowsInstallation({ installRoot, env = process.env, readShortcut = readWindowsShortcut, outside = [], keepForeignShortcuts = false } = {}) {
  if (!env.LOCALAPPDATA || !isAbsolute(env.LOCALAPPDATA) || (installRoot != null && !isAbsolute(installRoot))) {
    throw new Error('Absolute installation and current-user LOCALAPPDATA paths are required.');
  }
  installRoot = canonicalWindowsInstallPath(installRoot ?? join(env.LOCALAPPDATA, 'Programs', 'Fuli'));
  const recordPath = join(installRoot, 'installation.json');
  const record = readFileSync(recordPath);
  const current = readWindowsInstallation(JSON.parse(record).packageRoot);
  // Windows paths are case-insensitive: --install-root may differ in case from the record.
  if (!current || canonicalWindowsInstallPath(current.installRoot).toLowerCase() !== installRoot.toLowerCase()) throw new Error('Inconsistent Windows installation root.');
  for (const path of outside) {
    if (windowsInstallPathsOverlap(path, installRoot) || windowsInstallPathsOverlap(path, current.dataDir)) {
      throw new Error('Update from a package outside the installation and data directories.');
    }
  }
  const shortcuts = installedWindowsShortcuts(current, installRoot, readShortcut, outside, { keepForeign: keepForeignShortcuts });
  return { installRoot, current, record, recordPath, shortcuts };
}

export function planWindowsUpdate({ source, installRoot, env = process.env, readShortcut = readWindowsShortcut } = {}) {
  if (!source || !isAbsolute(source)) throw new Error('Absolute source, installation and current-user LOCALAPPDATA paths are required.');
  source = canonicalWindowsInstallPath(source);
  const installed = readCurrentWindowsInstallation({ installRoot, env, readShortcut, outside: [source] });
  const inventory = trayInventory(source);
  const applicationVersion = JSON.parse(readFileSync(join(source, 'package.json'))).version;
  if (compareSemanticVersions(applicationVersion, installed.current.applicationVersion) <= 0) throw new Error('The update package must be newer than the installed version.');
  snapshotWindowsUpdateRuntime(installed.current, source);
  return { source, ...installed, inventorySha256: inventory.inventorySha256, applicationVersion };
}

export async function updateWindowsInstallation(options, {
  runCli = runInstalledCli, createShortcut = createWindowsShortcut, readShortcut = readWindowsShortcut,
  acquireLock = acquireWindowsUpdateLock, write = () => {}
} = {}) {
  const plan = planWindowsUpdate({ ...options, readShortcut });
  if ((options.expectedInstallationId && options.expectedInstallationId !== plan.current.installationId)
      || (options.expectedInventorySha256 && options.expectedInventorySha256 !== plan.inventorySha256)) {
    throw new Error('The installation or update package changed after confirmation; review the update again.');
  }
  const lock = await acquireLock(plan.current.dataDir);
  try {
    lock.assertHeld();
    assertInstallationUnchanged(plan.recordPath, plan.record);
    const inventory = trayInventory(plan.source);
    if (inventory.inventorySha256 !== plan.inventorySha256) throw new Error('The update package changed while it was checked.');
    const installationId = randomUUID();
    const packageRoot = join(plan.installRoot, 'versions', installationId);
    mkdirSync(packageRoot);
    const discard = () => rmSync(packageRoot, { recursive: true, force: true });
    let staged;
    try {
      staged = stageUpdate(plan, inventory, installationId, packageRoot, createShortcut, readShortcut);
      staged.runtime = snapshotWindowsUpdateRuntime(plan.current, packageRoot);
    } catch (error) {
      discard();
      throw error;
    }
    return await stopAndSwitchWindowsInstallation(plan, staged, packageRoot, { runCli, lock, write, discard });
  } finally { await lock.release(); }
}

function stageUpdate(plan, inventory, installationId, packageRoot, createShortcut, readShortcut) {
  for (const [name, hash] of inventory.entries) {
    const bytes = readFileSync(join(plan.source, name));
    if (installationSha256(bytes) !== hash) throw new Error('The update package changed while it was copied: ' + name);
    mkdirSync(dirname(join(packageRoot, name)), { recursive: true });
    writeFileSync(join(packageRoot, name), bytes, { flag: 'wx' });
  }
  writeFileSync(join(packageRoot, 'tray-files.sha256.json'), inventory.bytes, { flag: 'wx' });
  resolveWindowsNativeBundle(readWindowsNativeBundle(packageRoot));
  const receipt = { version: 1, kind: 'windows-user-installation', installationId,
    installRoot: plan.installRoot, packageRoot, dataDir: plan.current.dataDir, inventorySha256: plan.inventorySha256 };
  writeFileSync(join(packageRoot, 'installed-context.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  const next = { ...receipt, status: 'installed', applicationVersion: plan.applicationVersion,
    shortcuts: plan.current.shortcuts, ...(plan.current.adoptedExistingData ? { adoptedExistingData: true } : {}),
    previousInstallation: { installationId: plan.current.installationId, packageRoot: plan.current.packageRoot,
      applicationVersion: plan.current.applicationVersion } };
  const shortcuts = stageWindowsShortcuts(plan.shortcuts, packageRoot, createShortcut, readShortcut);
  return { next, record: Buffer.from(JSON.stringify(next, null, 2) + '\n'), shortcuts };
}
