import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { isProcessAlive } from '../local-runtime/processes.js';

export async function assertManagedNeo4jHome(paths, home, version) {
  if (!isAbsolute(home ?? '')) throw new Error('Neo4j asset home must be absolute.');
  const root = resolve(paths.nativeRuntimeDir), name = `neo4j-community-${version}`;
  const rel = relative(root, resolve(home));
  if (rel !== name && !new RegExp(`^neo4j-assets/jvs-a-[a-f0-9-]+/${name.replaceAll('.', '\\.')}$$`).test(rel.split('\\').join('/'))) {
    throw new Error('Neo4j asset home is outside the managed version directories.');
  }
  for (const instance of [paths.nativePersonalDir, paths.nativeWorkspaceDir]) {
    if (instance && overlaps(home, instance)) throw new Error('Neo4j assets overlap instance data; refusing removal or switching.');
  }
  let current = root;
  for (const part of ['', ...rel.split(/[\\/]/)]) {
    current = join(current, part);
    try { if (!(await lstat(current)).isDirectory()) throw new Error('Neo4j asset directories must not be symbolic links.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return resolve(home);
}

export async function neo4jAssetFingerprint(home) {
  const hash = createHash('sha256');
  async function visit(directory) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new Error('Neo4j assets contain an unsupported link or file.');
      hash.update(relative(home, path)); hash.update('\0');
      if (entry.isDirectory()) await visit(path);
      else { for await (const bytes of createReadStream(path)) hash.update(bytes); hash.update('\0'); }
    }
  }
  await visit(home);
  return hash.digest('hex');
}

export async function acquireNeo4jLifecycleLock(root) {
  const path = join(root, '.neo4j-lifecycle.lock'), token = randomUUID();
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (!(await lstat(root)).isDirectory()) throw new Error('Neo4j runtime must not be a symbolic link.');
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('A Neo4j lifecycle lock exists. Inspect an interrupted operation before retrying.'); throw error; }
  const owner = join(path, 'owner');
  await writeFile(owner, token, { flag: 'wx', mode: 0o600 });
  // Which process took it, so a lock its holder never released (a start that
  // was killed) is recognised as abandoned and taken over (neo4j-lifecycle-lock).
  await writeFile(join(path, 'holder.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
    { flag: 'wx', mode: 0o600 });
  async function assertHeld() { if (await readFile(owner, 'utf8') !== token) throw new Error('Neo4j lifecycle lock ownership changed.'); }
  return { token, assertHeld, async release() { await assertHeld(); await rm(path, { recursive: true }); } };
}

export function assetContainer(paths, home) {
  return dirname(home) === resolve(paths.nativeRuntimeDir) ? home : dirname(home);
}
function overlaps(a, b) {
  const inside = (x, y) => { const rel = relative(resolve(x), resolve(y)); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`); };
  return inside(a, b) || inside(b, a);
}

// versions: the Neo4j versions this runtime may hold (the current one and a retained older patch).
export async function managedNeo4jContainers(paths, versions) {
  const root = join(paths.nativeRuntimeDir, 'neo4j-assets');
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (!(await lstat(root)).isDirectory()) throw new Error('Neo4j asset root must not be a symbolic link.');
  const containers = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^jvs-a-[a-f0-9-]+$/.test(entry.name)) throw new Error('Unknown Neo4j asset entry was preserved.');
    const container = join(root, entry.name);
    const receipt = JSON.parse(await readFile(join(container, 'fuli-asset-owner.json'), 'utf8'));
    if (receipt.kind !== 'fuli-neo4j-assets' || receipt.id !== entry.name || !versions.includes(receipt.version)) throw new Error('Unowned Neo4j asset directory was preserved.');
    await assertManagedNeo4jHome(paths, join(container, `neo4j-community-${receipt.version}`), receipt.version);
    containers.push(container);
  }
  return containers;
}

// Normal setup/start/stop/admin work shares the exclusive lifecycle lease. Only
// the operation that already owns the lease may reenter while switching assets.
export async function withNativeAssetOperation(paths, env, action, { isAlive = isProcessAlive } = {}) {
  const lockPath = join(paths.nativeRuntimeDir, '.neo4j-lifecycle.lock');
  releaseAbandonedNeo4jLifecycleLock(paths.nativeRuntimeDir, { isAlive });
  try {
    const owner = await readFile(join(lockPath, 'owner'), 'utf8');
    if (owner && env.FULI_NATIVE_ASSET_OPERATION === owner) return action(env);
    throw neo4jLifecycleLockError(paths.nativeRuntimeDir, { isAlive });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try {
    await lstat(join(paths.nativeRuntimeDir, 'neo4j-transaction.json'));
    throw new Error('A native Neo4j transaction needs recovery before starting services.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const lock = await acquireNeo4jLifecycleLock(paths.nativeRuntimeDir);
  try {
    try {
      await lstat(join(paths.nativeRuntimeDir, 'neo4j-transaction.json'));
      throw new Error('A native Neo4j transaction needs recovery before starting services.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return await action({ ...env, FULI_NATIVE_ASSET_OPERATION: lock.token });
  }
  finally { await lock.release(); }
}

// The lifecycle lock as it stands: where it is, since when, and the process
// that took it — null for a lock from before FULI recorded its holder. Null
// when there is no lock.
export function readNeo4jLifecycleLock(root) {
  const path = join(root, '.neo4j-lifecycle.lock');
  let since;
  try { since = statSync(path).mtime.toISOString(); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let pid = null;
  try { pid = JSON.parse(readFileSync(join(path, 'holder.json'), 'utf8'))?.pid ?? null; } catch { /* an older lock names no holder */ }
  return { path, since, pid: Number.isInteger(pid) && pid > 0 ? pid : null };
}

// A lock whose recorded holder has ended is released, so the start that comes
// after a killed one does not wait for ever. Never one that names no holder,
// one whose holder still runs, or one with a transaction waiting for recovery:
// those stay for a person. Answers whether it released one.
export function releaseAbandonedNeo4jLifecycleLock(root, { isAlive = isProcessAlive } = {}) {
  const lock = readNeo4jLifecycleLock(root);
  if (!lock || lock.pid === null || isAlive(lock.pid)) return false;
  if (existsSync(join(root, 'neo4j-transaction.json'))) return false;
  rmSync(lock.path, { recursive: true, force: true });
  return true;
}

// Why a start stopped at the lock, with the facts a person needs (startup-failure.js).
export function neo4jLifecycleLockError(root, { isAlive = isProcessAlive } = {}) {
  const lock = readNeo4jLifecycleLock(root);
  const holderRunning = lock?.pid !== null && lock?.pid !== undefined && isAlive(lock.pid);
  return Object.assign(new Error(`A native Neo4j lifecycle operation is in progress: its lock has been held since ${lock?.since ?? 'an unknown time'}`
    + (holderRunning ? ` by process ${lock.pid}, which is still running.` : ', with no record of a running holder.')), {
    code: 'native_lifecycle_lock',
    startupFailure: { code: 'native_lifecycle_lock', since: lock?.since ?? null, pid: lock?.pid ?? null,
      holderRunning, lockPath: lock?.path ?? join(root, '.neo4j-lifecycle.lock') }
  });
}
