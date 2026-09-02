import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, renameSync, rmSync, writeFileSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { EmployeeError, parseEmployeeManifest } from './manifest.js';
import { confinedPath, employeeDirectories } from './package-registry.js';

// Installation is an explicit local CLI action. The HTTP/MCP catalog never
// downloads code, follows a user-supplied executable URL, or executes installers.
export function installEmployeePackage({ sourceDirectory, runtimeConfigPath, replace = false }) {
  const source = resolve(sourceDirectory);
  const digest = packageDigest(source);
  const manifest = parseEmployeeManifest(JSON.parse(readFileSync(join(source, 'employee.json'), 'utf8')));
  if (manifest.runtime) {
    confinedPath(source, manifest.runtime.entry);
    confinedPath(source, `${manifest.runtime.webRoot}/index.html`);
  }
  const { packageDirectory } = employeeDirectories(runtimeConfigPath);
  mkdirSync(packageDirectory, { recursive: true });
  const target = join(packageDirectory, manifest.id);
  if (existsSync(target)) {
    // Verify the actual installed files, not an old receipt that may outlive an edit.
    let installedDigest;
    try { installedDigest = packageDigest(target); } catch { /* Explicit replacement is required for a damaged package. */ }
    if (installedDigest === digest) {
      return { id: manifest.id, version: manifest.version, idempotent: true, backupCreated: false };
    }
    if (!replace) throw new EmployeeError('Employee package already exists; use --replace to keep a backup and update it', 409, 'package_exists');
  }
  const staging = mkdtempSync(join(packageDirectory, '.install-'));
  let backup;
  try {
    cpSync(source, join(staging, 'package'), { recursive: true, dereference: false });
    if (packageDigest(join(staging, 'package')) !== digest) throw new TypeError('Employee package changed while installing');
    writeFileSync(join(staging, 'package', '.installation.json'), JSON.stringify({
      schemaVersion: 1, digest, installedAt: new Date().toISOString()
    }));
    if (existsSync(target)) {
      backup = `${target}.backup-${createHash('sha256').update(staging).digest('hex').slice(0, 12)}`;
      renameSync(target, backup);
    }
    try { renameSync(join(staging, 'package'), target); }
    catch (error) { if (backup) renameSync(backup, target); throw error; }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return { id: manifest.id, version: manifest.version, idempotent: false, backupCreated: Boolean(backup) };
}

function packageDigest(root) {
  let bytes = 0;
  let files = 0;
  const hash = createHash('sha256');
  function walk(directory, prefix = '') {
    if (lstatSync(directory).isSymbolicLink()) throw new TypeError('Employee packages may not contain symlinks');
    for (const name of readdirSync(directory).sort()) {
      if (name === '.env' || name.startsWith('.env.') || ['.git', 'node_modules'].includes(name)) {
        throw new TypeError('Employee packages must contain only built artifacts, not environments or repositories');
      }
      const file = join(directory, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new TypeError('Employee packages may not contain symlinks');
      // Only the generated root receipt is metadata; nested names are package content.
      if (name === '.installation.json' && prefix === '' && stat.isFile()) continue;
      if (stat.isDirectory()) { walk(file, `${prefix}${name}/`); continue; }
      if (!stat.isFile()) throw new TypeError('Unsupported employee package entry');
      bytes += stat.size;
      files += 1;
      if (bytes > 64 * 1024 * 1024 || files > 4096) throw new TypeError('Employee package exceeds the installation budget');
      hash.update(`${prefix}${name}\0`).update(readFileSync(file)).update('\0');
    }
  }
  walk(root);
  return hash.digest('hex');
}
