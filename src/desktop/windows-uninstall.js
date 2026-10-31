import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, rmdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { windowsDesktopClient } from './windows-desktop-client.js';
import { windowsInstallPathsOverlap } from './windows-installation-context.js';
import { readWindowsShortcut } from './windows-installation.js';
import { removeWindowsNodeLauncher } from './windows-node-launcher.js';
import { assertInstallationUnchanged, requireInstalledCli, runInstalledCli } from './windows-installation-switch.js';
import { readCurrentWindowsInstallation } from './windows-update.js';
import { acquireWindowsUpdateLock } from './windows-update-lock.js';

const SLOT = /^[a-f0-9-]{36}$/;

// Removes the per-user application: the desktop client closes, services stop,
// Agent client integrations are removed, then the record, own shortcuts, the
// client's Windows entries, the client-configuration launcher and version slots.
// Data is never touched.
export function planWindowsUninstall({ installRoot, env = process.env, readShortcut = readWindowsShortcut } = {}) {
  const installed = readCurrentWindowsInstallation({ installRoot, env, readShortcut, keepForeignShortcuts: true });
  const versions = join(installed.installRoot, 'versions');
  const entries = readdirSync(versions, { withFileTypes: true });
  // Only installer-named directories are removed; anything else is left in place.
  const slots = entries.filter(entry => entry.isDirectory() && SLOT.test(entry.name)).map(entry => join(versions, entry.name));
  return { ...installed, versions, slots };
}

export async function uninstallWindowsInstallation(options, {
  runCli = runInstalledCli, readShortcut = readWindowsShortcut, acquireLock = acquireWindowsUpdateLock,
  write = () => {}, removeAfterExit = removeWindowsDirectoriesAfterExit, runningFrom = process.execPath,
  desktopClient = windowsDesktopClient
} = {}) {
  const plan = planWindowsUninstall({ ...options, readShortcut });
  const { current } = plan;
  if (options.expectedInstallationId && options.expectedInstallationId !== current.installationId) {
    throw new Error('The installation changed after confirmation; review the uninstall again.');
  }
  // The running client would hold its version folder open and could start Fuli again.
  await desktopClient.close(current.dataDir);
  const lock = await acquireLock(current.dataDir);
  try {
    lock.assertHeld();
    assertInstallationUnchanged(plan.recordPath, plan.record);
    for (const shortcut of plan.shortcuts) assertInstallationUnchanged(shortcut.path, shortcut.bytes);
    write('Stopping Fuli ' + current.applicationVersion + '...');
    await requireInstalledCli(runCli, current.packageRoot, ['stop', '--data-dir', current.dataDir], 'The running Fuli could not be stopped; nothing was removed.');
    lock.assertHeld();
    write('Removing Agent client integrations...');
    await requireInstalledCli(runCli, current.packageRoot, ['uninstall', '--yes', '--data-dir', current.dataDir],
      'Agent client integrations could not be removed; the application was kept. Reopen Fuli to start it again.');
    lock.assertHeld();
    assertInstallationUnchanged(plan.recordPath, plan.record);
    unlinkSync(plan.recordPath);
    const keptShortcuts = [];
    for (const { path, bytes, foreign } of plan.shortcuts) {
      if (!bytes) continue;
      if (foreign) { keptShortcuts.push(path); continue; }
      try {
        assertInstallationUnchanged(path, bytes);
        unlinkSync(path);
      } catch { keptShortcuts.push(path); }
    }
    const registrations = await desktopClient.unregister(plan.installRoot);
    // A client session still open runs the launcher; it is removed once that ends.
    const heldFiles = removeWindowsNodeLauncher(plan.installRoot);
    const pending = [];
    for (const slot of plan.slots) {
      // The running node.exe locks its own slot; it is removed once this process exits.
      if (windowsInstallPathsOverlap(slot, runningFrom)) { pending.push(slot); continue; }
      try { rmSync(slot, { recursive: true }); } catch { pending.push(slot); }
    }
    const containers = [plan.versions, plan.installRoot];
    for (const path of containers) removeIfEmpty(path);
    const deferred = pending.length + heldFiles.length > 0;
    if (deferred) await removeAfterExit(pending, containers, heldFiles);
    return { status: deferred ? 'removing_after_exit' : 'removed', applicationVersion: current.applicationVersion,
      dataDir: current.dataDir, installRoot: plan.installRoot, keptShortcuts, registrations,
      leftover: existsSync(plan.installRoot) && !deferred ? plan.installRoot : null };
  } finally { await lock.release(); }
}

function removeIfEmpty(path) {
  try { if (lstatSync(path).isDirectory() && !readdirSync(path).length) rmdirSync(path); }
  catch { /* Leave a changed or nonempty directory for inspection. */ }
}

// PowerShell waits for this process and its console to exit. .NET Directory.Delete
// removes junctions without following them into other folders. A detached PowerShell
// has no console and exits at once, and a direct child dies with Node's job, so
// cmd's start launches it as a grandchild outside that job. This process must not
// exit before cmd does: closing Node's job while cmd is still starting kills both.
function removeWindowsDirectoriesAfterExit(directories, containers, files) {
  const input = Buffer.from(JSON.stringify({ directories, containers, files })).toString('base64');
  const script = '$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("' + input + '")) | ConvertFrom-Json; '
    + 'for($i=0;$i -lt 30;$i++){ Start-Sleep -Seconds 2; $left=@($p.directories | Where-Object { [IO.Directory]::Exists($_) }); '
    + 'foreach($d in $left){ try { [IO.Directory]::Delete($d,$true) } catch {} }; '
    + 'foreach($f in @($p.files | Where-Object { [IO.File]::Exists($_) })){ try { [IO.File]::Delete($f) } catch {} }; '
    + 'if(-not @($p.directories | Where-Object { [IO.Directory]::Exists($_) }).Count -and -not @($p.files | Where-Object { [IO.File]::Exists($_) }).Count){ break } }; '
    + 'foreach($c in $p.containers){ try { if([IO.Directory]::Exists($c) -and -not [IO.Directory]::EnumerateFileSystemEntries($c).GetEnumerator().MoveNext()){ [IO.Directory]::Delete($c,$false) } } catch {} }';
  const system = join(process.env.SystemRoot, 'System32');
  return new Promise(resolve => {
    spawn(join(system, 'cmd.exe'), ['/d', '/c', 'start', '""', '/b', join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { cwd: tmpdir(), stdio: 'ignore', windowsHide: true }).once('error', resolve).once('exit', resolve);
  });
}
