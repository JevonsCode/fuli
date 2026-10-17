import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
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

export function createWindowsShortcut(path, target) {
  const input = Buffer.from(JSON.stringify({ path, target, cwd: dirname(target) })).toString('base64');
  powershell('$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("' + input + '")) | ConvertFrom-Json; '
    + '$s=(New-Object -ComObject WScript.Shell).CreateShortcut($p.path); '
    + '$s.TargetPath=$p.target; $s.WorkingDirectory=$p.cwd; $s.IconLocation=$p.target; $s.Save()');
}

// Node cannot deny sharing on Windows, so the reader holds a .NET handle that
// denies write and delete (rename) sharing while it hashes the bytes and COM
// interprets them. Any failure, including a sharing violation, fails closed.
export function readWindowsShortcut(path, sha256) {
  const input = Buffer.from(JSON.stringify({ path, sha256 })).toString('base64');
  return JSON.parse(powershell('[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); '
    + '$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("' + input + '")) | ConvertFrom-Json; '
    + '$f=[IO.File]::Open($p.path,"Open","Read","Read"); try { '
    + '$b=New-Object byte[] $f.Length; $n=0; while($n -lt $b.Length){$r=$f.Read($b,$n,$b.Length-$n); if($r -le 0){throw "short read"}; $n+=$r}; '
    + '$h=-join([Security.Cryptography.SHA256]::Create().ComputeHash($b)|ForEach-Object{$_.ToString("x2")}); '
    + 'if($h -ne $p.sha256){throw "The shortcut bytes changed before verification."}; '
    + '$s=(New-Object -ComObject WScript.Shell).CreateShortcut($p.path); '
    + '@{targetPath=$s.TargetPath;arguments=$s.Arguments;workingDirectory=$s.WorkingDirectory} | ConvertTo-Json -Compress '
    + '} finally { $f.Dispose() }'));
}

// Windows file IDs exceed 2^53, so identities are compared as exact bigints.
const EXACT = { bigint: true };
const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameFile = (a, b) => sameInode(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs;

export function trayInventory(source) {
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

export function planFirstWindowsInstall({ source, installRoot, dataDir, shortcutDirectories, adoptExistingData = false, env = process.env } = {}) {
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
  const adoptedData = existingFuliData(dataDir, adoptExistingData);
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
  return { source, installRoot, dataDir, shortcuts, adoptedData, inventorySha256: inventory.inventorySha256,
    applicationVersion: JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version };
}

// First-install only: no existing app/data mutation, service actions or startup.
export function installWindowsForCurrentUser(options,
  { createShortcut = createWindowsShortcut, readShortcut = readWindowsShortcut } = {}) {
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
    mkdirSync(path); directories.push([path, lstatSync(path, EXACT)]);
  }
  function ownFile(path, bytes, { flags = 'wx', verify } = {}) {
    directory(dirname(path));
    const fd = openSync(path, flags);
    const owned = [path, fstatSync(fd, EXACT)];
    files.push(owned);
    try { writeFileSync(fd, bytes); verify?.(fd); }
    finally {
      // A write can create partial bytes before throwing. Snapshot the opened
      // inode, never a replacement at this path, so caught failures can clean it.
      try { owned[1] = fstatSync(fd, EXACT); }
      finally { closeSync(fd); }
    }
    return owned;
  }
  // COM Save cannot create exclusively, so it rewrites an inode this installer
  // created inside its own new package directory. Only that inode is adopted. It
  // stays open (read-only, which COM Save and the hash-bound reader both permit) so
  // a replacement cannot reuse its freed inode number, as POSIX filesystems do.
  function stageShortcut(staged, target) {
    const held = openSync(staged, constants.O_RDONLY | constants.O_CREAT | constants.O_EXCL);
    try { return verifyStagedShortcut(staged, target, held); } finally { closeSync(held); }
  }
  function verifyStagedShortcut(staged, target, held) {
    const owned = [staged, fstatSync(held, EXACT)];
    files.push(owned);
    let failure = null;
    try { createShortcut(staged, target); } catch (error) { failure = error; }
    const actual = lstatSync(staged, { ...EXACT, throwIfNoEntry: false });
    const adopted = Boolean(actual && sameInode(actual, owned[1]));
    if (adopted) owned[1] = actual;
    else files.splice(files.indexOf(owned), 1); // A replacement is left for inspection.
    if (failure) throw failure;
    if (!adopted) throw new Error('The shortcut was not saved into the installer-owned staging file: ' + staged);
    try {
      if (!sameFile(fstatSync(held, EXACT), owned[1])) throw new Error('The staged shortcut changed while it was read: ' + staged);
      const bytes = readFileSync(held);
      if (!bytes.length) throw new Error('The shortcut writer produced no shortcut.');
      // COM interprets these exact bytes (hash-bound) before any shared folder sees them.
      const link = readShortcut(staged, installationSha256(bytes));
      if (String(link?.targetPath ?? '').toLowerCase() !== target.toLowerCase() || (link.arguments ?? '') !== ''
          || String(link.workingDirectory ?? '').toLowerCase() !== dirname(target).toLowerCase()) {
        throw new Error('The shortcut does not point at the installed application: ' + staged);
      }
      return bytes;
    } finally { removeOwnedFile(...owned); }
  }
  // No shared temporary name: the final name is created exclusively (EEXIST leaves
  // any existing file alone) and filled from the verified bytes through this fd.
  function publishShortcut(path, bytes) {
    ownFile(path, bytes, { flags: 'wx+', verify(fd) {
      const written = Buffer.alloc(bytes.length + 1);
      const read = readSync(fd, written, 0, written.length, 0);
      if (read !== bytes.length || !written.subarray(0, read).equals(bytes)) {
        throw new Error('The published shortcut changed while it was written: ' + path);
      }
      const current = lstatSync(path, { ...EXACT, throwIfNoEntry: false });
      if (!current || !sameInode(current, fstatSync(fd, EXACT))) {
        throw new Error('The published shortcut was replaced while it was written: ' + path);
      }
    } });
  }
  try {
    directory(dirname(plan.installRoot));
    // Exclusive claim: another installer cannot pass by observing our new root.
    mkdirSync(plan.installRoot); directories.push([plan.installRoot, lstatSync(plan.installRoot, EXACT)]);
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
    const target = join(packageRoot, 'Fuli.exe');
    const staging = join(packageRoot, '.shortcut-staging');
    mkdirSync(staging); directories.push([staging, lstatSync(staging, EXACT)]);
    for (const [index, path] of plan.shortcuts.entries()) {
      directory(dirname(path));
      publishShortcut(path, stageShortcut(join(staging, index + '.lnk'), target));
    }
    rmdirSync(staging);
    // Only data adopted at planning time may exist; anything else appearing is refused.
    if (plan.adoptedData ? !existsSync(plan.dataDir) : existsSync(plan.dataDir)) {
      throw new Error(plan.adoptedData ? 'The adopted data directory disappeared during installation.'
        : 'The data directory appeared during installation; refusing to adopt it.');
    }
    const record = { ...receipt, status: 'installed', applicationVersion: plan.applicationVersion, shortcuts: plan.shortcuts,
      ...(plan.adoptedData ? { adoptedExistingData: true } : {}) };
    ownFile(join(plan.installRoot, 'installation.json'), JSON.stringify(record, null, 2) + '\n');
    return record;
  } catch (error) {
    for (const file of files.reverse()) removeOwnedFile(...file);
    // Non-recursive removal preserves files created by anyone else mid-install.
    for (const [path, identity] of directories.reverse()) {
      try {
        const actual = lstatSync(path, EXACT);
        if (actual.isDirectory() && sameInode(actual, identity)) rmdirSync(path);
      } catch { /* Leave nonempty or changed directories for inspection. */ }
    }
    throw error;
  }
}

// Existing data is bound only on explicit request and only when it is a Fuli
// data directory. Nothing in it is read beyond the runtime mode or changed.
function existingFuliData(dataDir, adopt) {
  if (!existsSync(dataDir)) {
    if (adopt) throw new Error('There is no existing data directory to adopt: ' + dataDir);
    return null;
  }
  if (!adopt) throw new Error('The data directory already exists. Rerun with --adopt-existing-data to use it; it will not be changed.');
  if (!lstatSync(dataDir).isDirectory()) throw new Error('The existing data path is not a directory: ' + dataDir);
  const settingsPath = join(dataDir, 'runtime-settings.json');
  const configured = existsSync(join(dataDir, 'graph-runtime.json'));
  if (!existsSync(settingsPath) && !configured) throw new Error('The existing directory is not Fuli data: ' + dataDir);
  const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : null;
  // The same default the runtime settings reader applies: no mode is container.
  const runtimeMode = settings?.graphRuntimeMode ?? 'container';
  if (!['container', 'native'].includes(runtimeMode)) throw new Error('The existing data has an unknown graph runtime mode.');
  return { runtimeMode };
}

function removeOwnedFile(path, identity) {
  try {
    if (sameFile(lstatSync(path, EXACT), identity)) unlinkSync(path);
  } catch { /* Never remove a replacement or hide the original install failure. */ }
}
