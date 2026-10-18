import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { compareSemanticVersions } from '../semantic-version.js';
import { canonicalWindowsInstallPath } from './windows-installation-context.js';
import { createWindowsShortcut, readWindowsShortcut, trayInventory } from './windows-installation.js';
import { assertInstallationUnchanged, runInstalledCli, stageWindowsShortcuts, stopAndSwitchWindowsInstallation } from './windows-installation-switch.js';
import { readCurrentWindowsInstallation } from './windows-update.js';
import { acquireWindowsUpdateLock } from './windows-update-lock.js';
import { snapshotWindowsUpdateRuntime } from './windows-update-runtime.js';

// User-initiated return to the version an update kept. Only the program switches:
// data and database contents stay as the newer version left them.
export function planWindowsRollback({ installRoot, env = process.env, readShortcut = readWindowsShortcut } = {}) {
  const installed = readCurrentWindowsInstallation({ installRoot, env, readShortcut });
  const previous = installed.current.previousInstallation;
  if (!previous) throw new Error('No earlier version is recorded for this installation; there is nothing to roll back to.');
  const target = keptWindowsVersion(installed, previous);
  snapshotWindowsUpdateRuntime(installed.current, target.packageRoot, { downgrade: true });
  return { ...installed, target, applicationVersion: target.applicationVersion };
}

export async function rollbackWindowsInstallation(options, {
  runCli = runInstalledCli, createShortcut = createWindowsShortcut, readShortcut = readWindowsShortcut,
  acquireLock = acquireWindowsUpdateLock, write = () => {}
} = {}) {
  const plan = planWindowsRollback({ ...options, readShortcut });
  if (options.expectedInstallationId && options.expectedInstallationId !== plan.current.installationId) {
    throw new Error('The installation changed after confirmation; review the rollback again.');
  }
  const lock = await acquireLock(plan.current.dataDir);
  try {
    lock.assertHeld();
    assertInstallationUnchanged(plan.recordPath, plan.record);
    const { target } = plan;
    if (trayInventory(target.packageRoot).inventorySha256 !== target.receipt.inventorySha256) {
      throw new Error('The kept version changed while it was checked; nothing was switched.');
    }
    const next = { ...target.receipt, status: 'installed', applicationVersion: target.applicationVersion,
      shortcuts: plan.current.shortcuts, ...(plan.current.adoptedExistingData ? { adoptedExistingData: true } : {}) };
    const staged = { next, record: Buffer.from(JSON.stringify(next, null, 2) + '\n'),
      shortcuts: stageWindowsShortcuts(plan.shortcuts, target.packageRoot, createShortcut, readShortcut),
      runtime: snapshotWindowsUpdateRuntime(plan.current, target.packageRoot, { downgrade: true }) };
    return await stopAndSwitchWindowsInstallation(plan, staged, target.packageRoot, { runCli, lock, write });
  } finally { await lock.release(); }
}

// The kept slot must be the complete, unmodified package an earlier install or
// update wrote for this installation root and data directory.
function keptWindowsVersion({ installRoot, current }, previous) {
  const fail = () => { throw new Error('The kept earlier version is missing or changed; rollback is not possible.'); };
  if (!/^[a-f0-9-]{36}$/.test(previous.installationId ?? '') || typeof previous.packageRoot !== 'string' || !isAbsolute(previous.packageRoot)) fail();
  const packageRoot = canonicalWindowsInstallPath(join(installRoot, 'versions', previous.installationId));
  if (packageRoot !== canonicalWindowsInstallPath(previous.packageRoot)) fail();
  let receipt, inventory, applicationVersion;
  try {
    receipt = JSON.parse(readFileSync(join(packageRoot, 'installed-context.json'), 'utf8'));
    inventory = trayInventory(packageRoot);
    applicationVersion = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
  } catch { fail(); }
  if (receipt.version !== 1 || receipt.kind !== 'windows-user-installation' || receipt.installationId !== previous.installationId
      || ['installRoot', 'packageRoot', 'dataDir'].some(key => typeof receipt[key] !== 'string' || !isAbsolute(receipt[key]))
      || canonicalWindowsInstallPath(receipt.packageRoot) !== packageRoot || canonicalWindowsInstallPath(receipt.installRoot) !== installRoot
      || canonicalWindowsInstallPath(receipt.dataDir) !== canonicalWindowsInstallPath(current.dataDir)
      || receipt.inventorySha256 !== inventory.inventorySha256 || applicationVersion !== previous.applicationVersion) fail();
  if (compareSemanticVersions(applicationVersion, current.applicationVersion) >= 0) {
    throw new Error('The kept version is not older than the installed one; use Update-Fuli to change versions.');
  }
  return { packageRoot, receipt, applicationVersion };
}
