import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { readWindowsNativeBundle, resolveWindowsNativeBundle } from '../native-runtime/windows-assets.js';
import { canonicalWindowsInstallPath, installationSha256, windowsInstallPathsOverlap } from './windows-installation-context.js';

function powershell(script) {
  return execFileSync(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from('$ErrorActionPreference="Stop"; $ProgressPreference="SilentlyContinue"; ' + script, 'utf16le').toString('base64')],
    { windowsHide: true, encoding: 'utf8', timeout: 30_000 });
}

function currentUserShortcutDirectories() {
  return JSON.parse(powershell('[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); '
    + '@{desktop=[Environment]::GetFolderPath("DesktopDirectory");startMenu=[Environment]::GetFolderPath("Programs")} | ConvertTo-Json -Compress'));
}

function createWindowsShortcut(path, target) {
  const input = Buffer.from(JSON.stringify({ path, target, cwd: dirname(target) })).toString('base64');
  powershell('$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("' + input + '")) | ConvertFrom-Json; '
    + '$s=(New-Object -ComObject WScript.Shell).CreateShortcut($p.path); '
    + '$s.TargetPath=$p.target; $s.WorkingDirectory=$p.cwd; $s.IconLocation=$p.target; $s.Save()');
}

function trayInventory(source) {
  const bytes = readFileSync(join(source, 'tray-files.sha256.json'));
  const entries = JSON.parse(bytes);
  if (!Array.isArray(entries)) throw new Error('Invalid tray checksum inventory.');
  const names = new Set();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string'
        || !/^[a-f0-9]{64}$/.test(entry[1]) || isAbsolute(entry[0]) || entry[0].includes(':')
        || entry[0].split(/[\\/]/).some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) {
      throw new Error('Invalid tray checksum path.');
    }
    const name = entry[0].replaceAll('\\', '/').toLowerCase();
    if (names.has(name) || ['installation.json', 'installed-context.json', 'tray-files.sha256.json'].includes(name)
        || name === 'data' || name.startsWith('data/')) throw new Error('Duplicate or mutable tray inventory path: ' + name);
    names.add(name);
    const path = join(source, entry[0]);
    if (!lstatSync(path).isFile() || relative(source, realpathSync(path)).startsWith('..')
        || installationSha256(readFileSync(path)) !== entry[1]) throw new Error('Tray checksum mismatch: ' + entry[0]);
  }
  for (const required of ['Fuli.exe', 'runtime/node/node.exe', 'src/cli.js', 'src/desktop/windows-controller.js', 'native-bundle.json', 'tray-config.json', 'package.json']) {
    if (!names.has(required.toLowerCase())) throw new Error('Missing complete tray asset: ' + required);
  }
  if (![...names].some(name => name.startsWith('node_modules/'))) throw new Error('Missing bundled production dependencies.');
  resolveWindowsNativeBundle(readWindowsNativeBundle(source));
  const config = JSON.parse(readFileSync(join(source, 'tray-config.json'), 'utf8'));
  if (config.version !== 1 || config.kind !== 'windows-tray-candidate') throw new Error('Expected a tray candidate bundle.');
  return { entries, inventorySha256: installationSha256(bytes), bytes };
}

export function planFirstWindowsInstall({ source, installRoot, dataDir, shortcutDirectories, env = process.env } = {}) {
  if (!source || !isAbsolute(source) || !env.LOCALAPPDATA || !isAbsolute(env.LOCALAPPDATA)
      || [installRoot, dataDir].some(path => path != null && (typeof path !== 'string' || !isAbsolute(path)))) {
    throw new Error('Absolute source, installation, data and current-user LOCALAPPDATA paths are required.');
  }
  source = canonicalWindowsInstallPath(source);
  installRoot = canonicalWindowsInstallPath(installRoot ?? join(env.LOCALAPPDATA, 'Programs', 'Fuli'));
  dataDir = canonicalWindowsInstallPath(dataDir ?? join(env.LOCALAPPDATA, 'Fuli'));
  if (windowsInstallPathsOverlap(source, installRoot) || windowsInstallPathsOverlap(source, dataDir)
      || windowsInstallPathsOverlap(installRoot, dataDir)) throw new Error('Application, source and data directories must be separate.');
  if (existsSync(installRoot)) throw new Error('Installation directory already exists. Updates are not supported by this first-install entry.');
  if (existsSync(dataDir)) throw new Error('The data directory already exists. Existing native/container data is not adopted or migrated.');
  const directories = shortcutDirectories ?? currentUserShortcutDirectories();
  const shortcuts = ['desktop', 'startMenu'].map(key => {
    if (typeof directories[key] !== 'string' || !isAbsolute(directories[key])) throw new Error('A current-user shortcut directory is unavailable: ' + key);
    const path = join(canonicalWindowsInstallPath(directories[key]), 'Fuli.lnk');
    if (existsSync(path)) throw new Error('A shortcut already exists: ' + path);
    if (windowsInstallPathsOverlap(installRoot, path) || windowsInstallPathsOverlap(dataDir, path)
        || windowsInstallPathsOverlap(source, path)) throw new Error('Shortcuts must be outside the source, application and data directories.');
    return path;
  });
  if (shortcuts[0] === shortcuts[1]) throw new Error('Desktop and Start menu directories must differ.');
  const inventory = trayInventory(source);
  return { source, installRoot, dataDir, shortcuts, inventorySha256: inventory.inventorySha256,
    applicationVersion: JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version };
}

// First-install only: no existing app/data mutation, service actions or startup.
export function installWindowsForCurrentUser(options, { createShortcut = createWindowsShortcut } = {}) {
  const plan = planFirstWindowsInstall(options);
  const inventory = trayInventory(plan.source);
  if (inventory.inventorySha256 !== plan.inventorySha256) throw new Error('Tray checksum inventory changed during installation.');
  const installationId = randomUUID();
  const packageRoot = join(plan.installRoot, 'versions', installationId);
  const files = [];
  const directories = [];
  function directory(path) {
    if (existsSync(path)) return;
    directory(dirname(path));
    mkdirSync(path); directories.push([path, lstatSync(path)]);
  }
  function ownFile(path, bytes) {
    directory(dirname(path)); writeFileSync(path, bytes, { flag: 'wx' }); files.push([path, lstatSync(path)]);
  }
  try {
    directory(dirname(plan.installRoot));
    // Exclusive claim: another installer cannot pass by observing our new root.
    mkdirSync(plan.installRoot); directories.push([plan.installRoot, lstatSync(plan.installRoot)]);
    for (const [name, hash] of inventory.entries) {
      const bytes = readFileSync(join(plan.source, name));
      if (installationSha256(bytes) !== hash) throw new Error('Tray checksum changed during installation: ' + name);
      ownFile(join(packageRoot, name), bytes);
    }
    ownFile(join(packageRoot, 'tray-files.sha256.json'), inventory.bytes);
    resolveWindowsNativeBundle(readWindowsNativeBundle(packageRoot));
    const receipt = { version: 1, kind: 'windows-user-installation', installationId,
      installRoot: plan.installRoot, packageRoot, dataDir: plan.dataDir, inventorySha256: plan.inventorySha256 };
    ownFile(join(packageRoot, 'installed-context.json'), JSON.stringify(receipt, null, 2) + '\n');
    for (const path of plan.shortcuts) {
      directory(dirname(path));
      const temp = join(dirname(path), '.fuli-' + installationId + '.lnk');
      try {
        createShortcut(temp, join(packageRoot, 'Fuli.exe'));
        files.push([temp, lstatSync(temp)]);
        linkSync(temp, path); // Atomic no-overwrite publication, including races.
        files.push([path, lstatSync(path)]);
      } finally {
        const owned = files.find(([name]) => name === temp);
        if (owned) removeOwnedFile(...owned);
      }
    }
    if (existsSync(plan.dataDir)) throw new Error('The data directory appeared during installation; refusing to adopt it.');
    const record = { ...receipt, status: 'installed', applicationVersion: plan.applicationVersion, shortcuts: plan.shortcuts };
    ownFile(join(plan.installRoot, 'installation.json'), JSON.stringify(record, null, 2) + '\n');
    return record;
  } catch (error) {
    for (const file of files.reverse()) removeOwnedFile(...file);
    // Non-recursive removal preserves files created by anyone else mid-install.
    for (const [path, identity] of directories.reverse()) {
      try {
        const actual = lstatSync(path);
        if (actual.isDirectory() && actual.ino === identity.ino && actual.dev === identity.dev) rmdirSync(path);
      } catch { /* Leave nonempty or changed directories for inspection. */ }
    }
    throw error;
  }
}

function removeOwnedFile(path, identity) {
  try {
    const actual = lstatSync(path);
    if (actual.ino === identity.ino && actual.dev === identity.dev && actual.size === identity.size && actual.mtimeMs === identity.mtimeMs) unlinkSync(path);
  } catch { /* Never remove a replacement or hide the original install failure. */ }
}
