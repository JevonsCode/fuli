import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { readWindowsNativeBundle, resolveWindowsNativeBundle } from '../native-runtime/windows-assets.js';
import { compareSemanticVersions } from '../semantic-version.js';
import { writeTextFileAtomic } from '../storage/json-file.js';
import { canonicalWindowsInstallPath, installationSha256, readWindowsInstallation, windowsInstallPathsOverlap } from './windows-installation-context.js';
import { createWindowsShortcut, readWindowsShortcut, trayInventory } from './windows-installation.js';
import { acquireWindowsUpdateLock } from './windows-update-lock.js';
import { restoreWindowsUpdateRuntime, snapshotWindowsUpdateRuntime } from './windows-update-runtime.js';

export function planWindowsUpdate({ source, installRoot, env = process.env, readShortcut = readWindowsShortcut } = {}) {
  if (!source || !isAbsolute(source) || !env.LOCALAPPDATA || !isAbsolute(env.LOCALAPPDATA)
      || (installRoot != null && !isAbsolute(installRoot))) throw new Error('Absolute source, installation and current-user LOCALAPPDATA paths are required.');
  source = canonicalWindowsInstallPath(source);
  installRoot = canonicalWindowsInstallPath(installRoot ?? join(env.LOCALAPPDATA, 'Programs', 'Fuli'));
  const recordPath = join(installRoot, 'installation.json');
  const record = readFileSync(recordPath);
  const current = readWindowsInstallation(JSON.parse(record).packageRoot);
  if (!current || canonicalWindowsInstallPath(current.installRoot) !== installRoot) throw new Error('Inconsistent Windows installation root.');
  if (windowsInstallPathsOverlap(source, installRoot) || windowsInstallPathsOverlap(source, current.dataDir)) {
    throw new Error('Update from a package outside the installation and data directories.');
  }
  const target = join(current.packageRoot, 'Fuli.exe');
  const shortcuts = current.shortcuts.map(path => {
    if (windowsInstallPathsOverlap(path, installRoot) || windowsInstallPathsOverlap(path, current.dataDir)
        || windowsInstallPathsOverlap(path, source)) throw new Error('Invalid installation shortcut location.');
    if (!existsSync(path)) return { path, bytes: null };
    const bytes = readFileSync(path);
    requireShortcut(readShortcut(path, installationSha256(bytes)), target);
    return { path, bytes };
  });
  if (new Set(shortcuts.map(s => canonicalWindowsInstallPath(s.path).toLowerCase())).size !== shortcuts.length) throw new Error('Duplicate installation shortcuts.');
  const inventory = trayInventory(source);
  const applicationVersion = JSON.parse(readFileSync(join(source, 'package.json'))).version;
  if (compareSemanticVersions(applicationVersion, current.applicationVersion) <= 0) throw new Error('The update package must be newer than the installed version.');
  snapshotWindowsUpdateRuntime(current, source);
  return { source, installRoot, current, shortcuts, record, recordPath, inventorySha256: inventory.inventorySha256, applicationVersion };
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
    unchanged(plan.recordPath, plan.record);
    const inventory = trayInventory(plan.source);
    if (inventory.inventorySha256 !== plan.inventorySha256) throw new Error('The update package changed while it was checked.');
    const installationId = randomUUID();
    const packageRoot = join(plan.installRoot, 'versions', installationId);
    mkdirSync(packageRoot);
    let staged;
    try {
      staged = stageUpdate(plan, inventory, installationId, packageRoot, createShortcut, readShortcut);
      staged.runtime = snapshotWindowsUpdateRuntime(plan.current, packageRoot);
      lock.assertHeld();
      unchanged(plan.recordPath, plan.record);
      for (const shortcut of plan.shortcuts) unchanged(shortcut.path, shortcut.bytes);
      write('Stopping the running Fuli ' + plan.current.applicationVersion + '...');
      await requireCli(runCli, plan.current.packageRoot, ['stop', '--data-dir', plan.current.dataDir], 'The running Fuli could not be stopped; nothing was switched.');
    } catch (error) {
      rmSync(packageRoot, { recursive: true, force: true });
      throw error;
    }
    return await switchUpdate(plan, staged, packageRoot, runCli, lock, write);
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
  const target = join(packageRoot, 'Fuli.exe');
  const shortcuts = plan.shortcuts.map(({ bytes }, index) => {
    if (!bytes) return null; // Preserve a shortcut deliberately removed by its owner.
    const path = join(packageRoot, '.update-shortcut-' + index + '.lnk');
    createShortcut(path, target);
    const result = readFileSync(path);
    requireShortcut(readShortcut(path, installationSha256(result)), target);
    unlinkSync(path);
    return result;
  });
  return { next, record: Buffer.from(JSON.stringify(next, null, 2) + '\n'), shortcuts };
}

async function switchUpdate(plan, staged, packageRoot, runCli, lock, write) {
  const execute = runCli;
  runCli = async (...args) => {
    lock.assertHeld();
    const result = await execute(...args);
    lock.assertHeld();
    return result;
  };
  const { current } = plan;
  const args = command => [command, '--data-dir', current.dataDir];
  let switched = false, started = false;
  const replaced = [];
  try {
    lock.assertHeld();
    unchanged(plan.recordPath, plan.record);
    for (const shortcut of plan.shortcuts) unchanged(shortcut.path, shortcut.bytes);
    writeTextFileAtomic(plan.recordPath, staged.record);
    switched = true;
    plan.shortcuts.forEach(({ path, bytes }, index) => {
      if (bytes) { unchanged(path, bytes); writeTextFileAtomic(path, staged.shortcuts[index]); replaced.push(index); }
    });
    started = true;
    write('Starting Fuli ' + plan.applicationVersion + '...');
    await requireCli(runCli, packageRoot, args('start'), 'The updated Fuli did not start.');
    await requireCli(runCli, packageRoot, args('status'), 'The updated Fuli did not report a running state.');
  } catch (error) {
    lock.assertHeld(); // A lost owner must not interfere with another updater.
    // Stop while the new receipt is still authoritative. Never restart the old
    // version when the new process may still be using the same database.
    if (started) {
      try { await requireCli(runCli, packageRoot, args('stop'), 'The updated Fuli could not be stopped; automatic rollback was not attempted.'); }
      catch (stopError) { throw new AggregateError([error, stopError], stopError.message); }
    }
    lock.assertHeld();
    restoreWindowsUpdateRuntime(staged.runtime, plan.applicationVersion);
    const failures = [];
    if (switched) try { unchanged(plan.recordPath, staged.record); writeTextFileAtomic(plan.recordPath, plan.record); } catch (caught) { failures.push(caught); }
    for (const index of replaced) {
      const { path, bytes } = plan.shortcuts[index];
      try { unchanged(path, staged.shortcuts[index]); writeTextFileAtomic(path, bytes); } catch (caught) { failures.push(caught); }
    }
    try {
      lock.assertHeld();
      unchanged(plan.recordPath, plan.record);
      await requireCli(runCli, current.packageRoot, args('start'), 'The previous Fuli did not start again.');
      await requireCli(runCli, current.packageRoot, args('status'), 'The previous Fuli did not report a running state.');
    } catch (caught) { failures.push(caught); }
    if (failures.length) throw new AggregateError([error, ...failures], 'Rollback needs attention: ' + failures.map(e => e.message).join('; '));
    throw new Error(`${error.message} Fuli ${current.applicationVersion} was restored; the new copy is kept at ${packageRoot}.`, { cause: error });
  }
  write('Reconnecting already connected Agent clients...');
  let clients = 'not_reconnected';
  try {
    const result = await runCli(packageRoot, ['setup', '--yes', '--connected-only', '--data-dir', current.dataDir]);
    if (result.code === 0) clients = 'reconnected';
  } catch { /* Report integration refresh separately from the final runtime check. */ }
  await requireCli(runCli, packageRoot, args('status'), 'The new version is installed, but its runtime needs attention after client reconnection. Reopen Fuli to inspect its status.');
  return { ...staged.next, clients };
}

function unchanged(path, bytes) {
  if (bytes === null ? existsSync(path) : !existsSync(path) || !readFileSync(path).equals(bytes)) throw new Error('Installation file or shortcut changed; left unchanged: ' + path);
}
function requireShortcut(link, target) {
  if (String(link?.targetPath ?? '').toLowerCase() !== target.toLowerCase() || link.arguments
      || String(link?.workingDirectory ?? '').toLowerCase() !== dirname(target).toLowerCase()) throw new Error('A shortcut no longer launches the selected Fuli; it was left unchanged.');
}
async function requireCli(runCli, packageRoot, args, message) {
  const result = await runCli(packageRoot, args);
  if (result.code !== 0) throw new Error(message); // Do not echo CLI output containing user data or access codes.
  return result;
}
function runInstalledCli(packageRoot, args) {
  return new Promise(resolveRun => {
    execFile(join(packageRoot, 'runtime', 'node', 'node.exe'), [join(packageRoot, 'src', 'cli.js'), ...args], {
      cwd: packageRoot, env: process.env, windowsHide: true, encoding: 'utf8', timeout: 600_000, maxBuffer: 8 * 1024 * 1024
    }, error => resolveRun({ code: error ? error.code ?? 1 : 0 }));
  });
}
