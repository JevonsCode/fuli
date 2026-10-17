import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { readWindowsNativeBundle, resolveWindowsNativeBundle } from '../native-runtime/windows-assets.js';
import {
  canonicalWindowsInstallPath, installationSha256, readWindowsInstallation, windowsInstallPathsOverlap
} from './windows-installation-context.js';
import { createWindowsShortcut, readWindowsShortcut, trayInventory } from './windows-installation.js';

/**
 * Read-only preview of replacing the installed version with a verified
 * candidate. The current version must be a consistent installation whose
 * shortcuts still launch it; nothing is written.
 */
export function planWindowsUpdate({ source, installRoot, env = process.env, readShortcut = readWindowsShortcut } = {}) {
  if (!source || !isAbsolute(source) || !env.LOCALAPPDATA || !isAbsolute(env.LOCALAPPDATA)
      || (installRoot != null && !isAbsolute(installRoot))) {
    throw new Error('Absolute source, installation and current-user LOCALAPPDATA paths are required.');
  }
  source = canonicalWindowsInstallPath(source);
  installRoot = canonicalWindowsInstallPath(installRoot ?? join(env.LOCALAPPDATA, 'Programs', 'Fuli'));
  const recordPath = join(installRoot, 'installation.json');
  if (!existsSync(recordPath)) throw new Error('There is no installed Fuli to update at ' + installRoot + '.');
  if (windowsInstallPathsOverlap(source, installRoot)) throw new Error('Update from a package outside the installation directory.');
  const current = readWindowsInstallation(JSON.parse(readFileSync(recordPath, 'utf8')).packageRoot);
  if (!current) throw new Error('The installed Fuli has no valid installation record.');
  if (windowsInstallPathsOverlap(source, current.dataDir)) throw new Error('Update from a package outside the data directory.');
  const target = join(current.packageRoot, 'Fuli.exe');
  const shortcuts = current.shortcuts.map((path) => {
    if (!existsSync(path)) return { path, bytes: null };
    const bytes = readFileSync(path);
    const link = readShortcut(path, installationSha256(bytes));
    if (String(link?.targetPath ?? '').toLowerCase() !== target.toLowerCase()) {
      throw new Error('A shortcut no longer launches the installed Fuli; it was left unchanged: ' + path);
    }
    return { path, bytes };
  });
  const inventory = trayInventory(source);
  return { source, installRoot, current, shortcuts, inventorySha256: inventory.inventorySha256,
    applicationVersion: JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version };
}

/**
 * Installs a candidate as a new version beside the current one, then switches
 * to it: stop the running Fuli with its own CLI, switch the installation
 * record, repoint the shortcuts and start the new version. If the new version
 * does not start, the record, shortcuts and runtime go back to the previous
 * version, which is kept on disk. Data is never copied, moved or deleted.
 */
export async function updateWindowsInstallation(options, {
  runCli = runInstalledCli, createShortcut = createWindowsShortcut, readShortcut = readWindowsShortcut,
  write = () => {}
} = {}) {
  const plan = planWindowsUpdate({ ...options, readShortcut });
  const inventory = trayInventory(plan.source);
  if (inventory.inventorySha256 !== plan.inventorySha256) throw new Error('The update package changed while it was checked.');
  const { current } = plan;
  const installationId = randomUUID();
  const packageRoot = join(plan.installRoot, 'versions', installationId);

  write('Copying the verified package into ' + packageRoot + '...');
  mkdirSync(packageRoot);
  try {
    preparePackage();
  } catch (error) {
    // The new version directory was created exclusively under a fresh id, so
    // everything in it is this update's own partial copy.
    rmSync(packageRoot, { recursive: true, force: true });
    throw error;
  }
  function preparePackage() {
  for (const [name, hash] of inventory.entries) {
    const bytes = readFileSync(join(plan.source, name));
    if (installationSha256(bytes) !== hash) throw new Error('The update package changed while it was copied: ' + name);
    mkdirSync(dirname(join(packageRoot, name)), { recursive: true });
    writeFileSync(join(packageRoot, name), bytes, { flag: 'wx' });
  }
  writeFileSync(join(packageRoot, 'tray-files.sha256.json'), inventory.bytes, { flag: 'wx' });
  resolveWindowsNativeBundle(readWindowsNativeBundle(packageRoot));
  const receipt = { version: 1, kind: 'windows-user-installation', installationId,
    installRoot: plan.installRoot, packageRoot, dataDir: current.dataDir, inventorySha256: plan.inventorySha256 };
  writeFileSync(join(packageRoot, 'installed-context.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  const next = { ...receipt, status: 'installed', applicationVersion: plan.applicationVersion,
    shortcuts: current.shortcuts, ...(current.adoptedExistingData ? { adoptedExistingData: true } : {}),
    previousInstallation: { installationId: current.installationId, packageRoot: current.packageRoot,
      applicationVersion: current.applicationVersion } };
  const target = join(packageRoot, 'Fuli.exe');
  var staged = plan.shortcuts.map(({ path }, index) => {
    const staging = join(packageRoot, '.shortcut-staging');
    mkdirSync(staging, { recursive: true });
    const stage = join(staging, index + '.lnk');
    createShortcut(stage, target);
    const bytes = readFileSync(stage);
    const link = readShortcut(stage, installationSha256(bytes));
    if (String(link?.targetPath ?? '').toLowerCase() !== target.toLowerCase()) {
      throw new Error('The new shortcut does not point at the updated Fuli: ' + path);
    }
    unlinkSync(stage);
    return bytes;
  });
  if (plan.shortcuts.length) rmdirSync(join(packageRoot, '.shortcut-staging'));
  return staged;
  }

  write('Stopping the running Fuli ' + current.applicationVersion + '...');
  await requireCli(runCli, current.packageRoot, ['stop'], 'The running Fuli could not be stopped; nothing was switched.');

  const recordPath = join(plan.installRoot, 'installation.json');
  const previousRecord = readFileSync(recordPath);
  try {
    replaceFile(recordPath, Buffer.from(JSON.stringify(next, null, 2) + '\n'));
    plan.shortcuts.forEach(({ path, bytes }, index) => { if (bytes) replaceFile(path, staged[index]); });
    write('Starting Fuli ' + plan.applicationVersion + '...');
    await requireCli(runCli, packageRoot, ['start'], 'The updated Fuli did not start.');
    await requireCli(runCli, packageRoot, ['status'], 'The updated Fuli did not report a running state.');
  } catch (error) {
    write('Going back to Fuli ' + current.applicationVersion + '...');
    const failures = [];
    try { replaceFile(recordPath, previousRecord); } catch (caught) { failures.push(caught); }
    for (const { path, bytes } of plan.shortcuts) {
      if (bytes) try { replaceFile(path, bytes); } catch (caught) { failures.push(caught); }
    }
    try { await runCli(packageRoot, ['stop']); } catch { /* The new version may not have started. */ }
    try { await requireCli(runCli, current.packageRoot, ['start'], 'The previous Fuli did not start again.'); }
    catch (caught) { failures.push(caught); }
    if (failures.length) {
      throw new AggregateError([error, ...failures], `${error.message} Going back also failed: `
        + failures.map((failure) => failure.message).join('; '));
    }
    throw new Error(`${error.message} Fuli ${current.applicationVersion} was restored; the new copy is kept at ${packageRoot}.`, { cause: error });
  }

  write('Reconnecting Agent clients to the updated Fuli...');
  const clients = await runCli(packageRoot, ['setup', '--yes', '--connected-only']);
  return { ...next, clients: clients.code === 0 ? 'reconnected' : 'not_reconnected' };
}

async function requireCli(runCli, packageRoot, args, message) {
  const result = await runCli(packageRoot, args);
  if (result.code !== 0) {
    throw new Error(message + (result.stderr ? ' ' + String(result.stderr).trim().slice(-2000) : ''));
  }
  return result;
}

// Same-directory exclusive temporary file, then an atomic replace.
function replaceFile(path, bytes) {
  const temporary = path + '.fuli-update-' + randomUUID();
  writeFileSync(temporary, bytes, { flag: 'wx' });
  try { renameSync(temporary, path); }
  catch (error) { try { unlinkSync(temporary); } catch { /* Keep the original error. */ } throw error; }
}

function runInstalledCli(packageRoot, args) {
  return new Promise((resolveRun) => {
    execFile(join(packageRoot, 'runtime', 'node', 'node.exe'), [join(packageRoot, 'src', 'cli.js'), ...args], {
      cwd: packageRoot, env: process.env, windowsHide: true, encoding: 'utf8', timeout: 600_000,
      maxBuffer: 8 * 1024 * 1024
    }, (error, stdout, stderr) => resolveRun({ code: error ? error.code ?? 1 : 0, stdout, stderr }));
  });
}
