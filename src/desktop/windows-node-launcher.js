import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// FuliNode.exe (desktop/windows/FuliNodeLauncher.cs) at the installation root,
// beside installation.json: the stable command of an installed FULI's client
// configurations (rec#11 D-77). It runs the version installation.json names, so
// install, update and rollback only copy the launcher of the version they
// install; no client configuration is rewritten.
export const WINDOWS_NODE_LAUNCHER = 'FuliNode.exe';

// A launcher set aside while a client still runs it, or a copy a crash left behind.
const LAUNCHER_LEFTOVER = /^FuliNode\.exe\.[a-f0-9-]{36}\.(?:new|old)$/;

// The launcher clients run for this installation, or null before one was placed
// (a version from before D-77 installed it), when clients keep absolute paths.
export function installedWindowsNodeLauncher(installRoot) {
  const path = join(installRoot, WINDOWS_NODE_LAUNCHER);
  return existsSync(path) ? path : null;
}

// The launcher a verified package ships, or null for a version from before D-77.
export function packagedWindowsNodeLauncher(packageRoot) {
  const path = join(packageRoot, WINDOWS_NODE_LAUNCHER);
  return existsSync(path) ? readFileSync(path) : null;
}

// Copies packageRoot's launcher to the installation root. Any version's launcher
// runs any version's installation.json, so a package without one keeps the
// current launcher. Windows refuses to replace or delete a program a client is
// running but lets it be renamed: the old launcher moves aside and goes once free.
export function placeWindowsNodeLauncher(installRoot, packageRoot) {
  const bytes = packagedWindowsNodeLauncher(packageRoot);
  removeLauncherLeftovers(installRoot);
  if (!bytes) return 'kept';
  const target = join(installRoot, WINDOWS_NODE_LAUNCHER);
  if (existsSync(target) && readFileSync(target).equals(bytes)) return 'current';
  const staged = join(installRoot, `${WINDOWS_NODE_LAUNCHER}.${randomUUID()}.new`);
  writeFileSync(staged, bytes, { flag: 'wx' });
  const retired = join(installRoot, `${WINDOWS_NODE_LAUNCHER}.${randomUUID()}.old`);
  let aside = false;
  try {
    if (existsSync(target)) { renameSync(target, retired); aside = true; }
    renameSync(staged, target);
  } catch (error) {
    if (aside && !existsSync(target)) renameSync(retired, target);
    rmSync(staged, { force: true });
    throw error;
  }
  removeLauncherLeftovers(installRoot);
  return 'replaced';
}

// Removes the launcher and its leftovers; returns the paths a running client still holds.
export function removeWindowsNodeLauncher(installRoot) {
  const held = removeLauncherLeftovers(installRoot);
  const target = join(installRoot, WINDOWS_NODE_LAUNCHER);
  try { unlinkSync(target); } catch (error) { if (error.code !== 'ENOENT') held.push(target); }
  return held;
}

// A leftover a client still runs stays; a later placement or removal tries again.
function removeLauncherLeftovers(installRoot) {
  const held = [];
  for (const name of readdirSync(installRoot).filter(entry => LAUNCHER_LEFTOVER.test(entry))) {
    try { unlinkSync(join(installRoot, name)); } catch { held.push(join(installRoot, name)); }
  }
  return held;
}
