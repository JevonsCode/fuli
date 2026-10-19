import { execFile } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeTextFileAtomic } from '../storage/json-file.js';
import { canonicalWindowsInstallPath, installationSha256, windowsInstallPathsOverlap } from './windows-installation-context.js';
import { prepareWindowsUpdateRuntime, restoreWindowsUpdateRuntime } from './windows-update-runtime.js';

// Switching the installed version: shared by update and user-initiated rollback.
// The record and shortcuts change only after the running version has stopped,
// and any failure stops the target before the current version starts again.

// The current shortcuts with their exact bytes; an absent one stays absent. With
// keepForeign, a shortcut that no longer launches this version is marked, not refused.
export function installedWindowsShortcuts(current, installRoot, readShortcut, outside, { keepForeign = false } = {}) {
  const target = join(current.packageRoot, 'Fuli.exe');
  const shortcuts = current.shortcuts.map(path => {
    if ([installRoot, current.dataDir, ...outside].some(root => windowsInstallPathsOverlap(path, root))) {
      throw new Error('Invalid installation shortcut location.');
    }
    if (!existsSync(path)) return { path, bytes: null };
    const bytes = readFileSync(path);
    try { requireShortcut(readShortcut(path, installationSha256(bytes)), target); }
    catch (error) {
      if (!keepForeign) throw error;
      return { path, bytes, foreign: true };
    }
    return { path, bytes };
  });
  if (new Set(shortcuts.map(s => canonicalWindowsInstallPath(s.path).toLowerCase())).size !== shortcuts.length) throw new Error('Duplicate installation shortcuts.');
  return shortcuts;
}

// Verified shortcut bytes that launch packageRoot, staged inside packageRoot.
export function stageWindowsShortcuts(shortcuts, packageRoot, createShortcut, readShortcut) {
  const target = join(packageRoot, 'Fuli.exe');
  return shortcuts.map(({ bytes }, index) => {
    if (!bytes) return null; // Preserve a shortcut deliberately removed by its owner.
    const path = join(packageRoot, '.update-shortcut-' + index + '.lnk');
    createShortcut(path, target);
    const result = readFileSync(path);
    requireShortcut(readShortcut(path, installationSha256(result)), target);
    unlinkSync(path);
    return result;
  });
}

export async function stopAndSwitchWindowsInstallation(plan, staged, packageRoot, { runCli, lock, write, discard = () => {} }) {
  try {
    lock.assertHeld();
    assertInstallationUnchanged(plan.recordPath, plan.record);
    for (const shortcut of plan.shortcuts) assertInstallationUnchanged(shortcut.path, shortcut.bytes);
    write('Stopping the running Fuli ' + plan.current.applicationVersion + '...');
    await requireInstalledCli(runCli, plan.current.packageRoot, ['stop', '--data-dir', plan.current.dataDir], 'The running Fuli could not be stopped; nothing was switched.');
  } catch (error) {
    discard();
    throw error;
  }
  return switchInstallation(plan, staged, packageRoot, runCli, lock, write);
}

async function switchInstallation(plan, staged, packageRoot, runCli, lock, write) {
  const execute = runCli;
  runCli = async (...args) => {
    lock.assertHeld();
    const result = await execute(...args);
    lock.assertHeld();
    return result;
  };
  const { current } = plan;
  const args = command => [command, '--data-dir', current.dataDir];
  // A confirmed downgrade lets the new version replace the recorded Provider.
  const startArgs = () => plan.downgrade ? [...args('start'), '--allow-provider-downgrade'] : args('start');
  let switched = false, started = false;
  const replaced = [];
  try {
    lock.assertHeld();
    assertInstallationUnchanged(plan.recordPath, plan.record);
    for (const shortcut of plan.shortcuts) assertInstallationUnchanged(shortcut.path, shortcut.bytes);
    prepareWindowsUpdateRuntime(staged.runtime);
    writeTextFileAtomic(plan.recordPath, staged.record);
    switched = true;
    plan.shortcuts.forEach(({ path, bytes }, index) => {
      if (bytes) { assertInstallationUnchanged(path, bytes); writeTextFileAtomic(path, staged.shortcuts[index]); replaced.push(index); }
    });
    started = true;
    write('Starting Fuli ' + plan.applicationVersion + '...');
    await requireInstalledCli(runCli, packageRoot, startArgs(), 'Fuli ' + plan.applicationVersion + ' did not start.');
    await requireInstalledCli(runCli, packageRoot, args('status'), 'Fuli ' + plan.applicationVersion + ' did not report a running state.');
  } catch (error) {
    lock.assertHeld(); // A lost owner must not interfere with another updater.
    // Stop while the new receipt is still authoritative. Never restart the old
    // version when the new process may still be using the same database.
    if (started) {
      try { await requireInstalledCli(runCli, packageRoot, args('stop'), 'Fuli ' + plan.applicationVersion + ' could not be stopped; automatic rollback was not attempted.'); }
      catch (stopError) { throw new AggregateError([error, stopError], stopError.message); }
    }
    lock.assertHeld();
    restoreWindowsUpdateRuntime(staged.runtime, plan.applicationVersion);
    const failures = [];
    if (switched) try { assertInstallationUnchanged(plan.recordPath, staged.record); writeTextFileAtomic(plan.recordPath, plan.record); } catch (caught) { failures.push(caught); }
    for (const index of replaced) {
      const { path, bytes } = plan.shortcuts[index];
      try { assertInstallationUnchanged(path, staged.shortcuts[index]); writeTextFileAtomic(path, bytes); } catch (caught) { failures.push(caught); }
    }
    try {
      lock.assertHeld();
      assertInstallationUnchanged(plan.recordPath, plan.record);
      await requireInstalledCli(runCli, current.packageRoot, args('start'), 'The previous Fuli did not start again.');
      await requireInstalledCli(runCli, current.packageRoot, args('status'), 'The previous Fuli did not report a running state.');
    } catch (caught) { failures.push(caught); }
    if (failures.length) throw new AggregateError([error, ...failures], 'Rollback needs attention: ' + failures.map(e => e.message).join('; '));
    throw new Error(`${error.message} Fuli ${current.applicationVersion} was restored; the other copy is kept at ${packageRoot}.`, { cause: error });
  }
  write('Reconnecting already connected Agent clients...');
  let clients = 'not_reconnected';
  try {
    const result = await runCli(packageRoot, ['setup', '--yes', '--connected-only', '--data-dir', current.dataDir,
      ...(plan.downgrade ? ['--allow-provider-downgrade'] : [])]);
    if (result.code === 0) clients = 'reconnected';
  } catch { /* Report integration refresh separately from the final runtime check. */ }
  await requireInstalledCli(runCli, packageRoot, args('status'), 'Fuli ' + plan.applicationVersion + ' is installed, but its runtime needs attention after client reconnection. Reopen Fuli to inspect its status.');
  return { ...staged.next, clients };
}

export function assertInstallationUnchanged(path, bytes) {
  if (bytes === null ? existsSync(path) : !existsSync(path) || !readFileSync(path).equals(bytes)) throw new Error('Installation file or shortcut changed; left unchanged: ' + path);
}
export function requireShortcut(link, target) {
  if (String(link?.targetPath ?? '').toLowerCase() !== target.toLowerCase() || link.arguments
      || String(link?.workingDirectory ?? '').toLowerCase() !== dirname(target).toLowerCase()) throw new Error('A shortcut no longer launches the selected Fuli; it was left unchanged.');
}
export async function requireInstalledCli(runCli, packageRoot, args, message) {
  const result = await runCli(packageRoot, args);
  if (result.code !== 0) throw new Error(message); // Do not echo CLI output containing user data or access codes.
  return result;
}
export function runInstalledCli(packageRoot, args) {
  return new Promise(resolveRun => {
    execFile(join(packageRoot, 'runtime', 'node', 'node.exe'), [join(packageRoot, 'src', 'cli.js'), ...args], {
      cwd: packageRoot, env: process.env, windowsHide: true, encoding: 'utf8', timeout: 600_000, maxBuffer: 8 * 1024 * 1024
    }, error => resolveRun({ code: error ? error.code ?? 1 : 0 }));
  });
}
