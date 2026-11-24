import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { acquireNeo4jLifecycleLock, neo4jLifecycleLockError, releaseAbandonedNeo4jLifecycleLock } from './neo4j-lifecycle-lock.js';

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

export function assetContainer(paths, home) {
  return dirname(home) === resolve(paths.nativeRuntimeDir) ? home : dirname(home);
}
function overlaps(a, b) {
  const inside = (x, y) => { const rel = relative(resolve(x), resolve(y)); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`); };
  return inside(a, b) || inside(b, a);
}

// versions: the Neo4j versions this runtime may hold (the current one and a retained older patch).
// [leftovers]: for finishing an uninstall that was killed while it removed
// these directories: a jvs-a-* whose receipt is already gone counts when all
// that is left in it is one of these versions' programs, and anything else is
// left where it is instead of refusing.
export async function managedNeo4jContainers(paths, versions, { leftovers = false } = {}) {
  const root = join(paths.nativeRuntimeDir, 'neo4j-assets');
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (!(await lstat(root)).isDirectory()) throw new Error('Neo4j asset root must not be a symbolic link.');
  const containers = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^jvs-a-[a-f0-9-]+$/.test(entry.name)) {
      if (leftovers) continue;
      throw new Error('Unknown Neo4j asset entry was preserved.');
    }
    const container = join(root, entry.name);
    let receipt = null;
    try { receipt = JSON.parse(await readFile(join(container, 'fuli-asset-owner.json'), 'utf8')); }
    catch (error) { if (!leftovers) throw error; }
    if (!receipt && leftovers) {
      const left = await readdir(container);
      const version = left.length === 1 ? versions.find(candidate => left[0] === `neo4j-community-${candidate}`) : undefined;
      if (left.length === 0 || version) {
        if (version) await assertManagedNeo4jHome(paths, join(container, left[0]), version);
        containers.push(container);
      }
      continue;
    }
    if (receipt.kind !== 'fuli-neo4j-assets' || receipt.id !== entry.name || !versions.includes(receipt.version)) {
      if (leftovers) continue;
      throw new Error('Unowned Neo4j asset directory was preserved.');
    }
    await assertManagedNeo4jHome(paths, join(container, `neo4j-community-${receipt.version}`), receipt.version);
    containers.push(container);
  }
  return containers;
}

// The program directories an uninstall of [current] removes: each version's
// default home, the FULI asset directories holding one of those versions, and
// the directories of the homes the descriptor names — every home checked to be
// one FULI manages first. A recovery finishing a killed uninstall asks with
// [leftovers] (managedNeo4jContainers); directories already gone are answered too.
export async function uninstallContainers(paths, current, { leftovers = false } = {}) {
  // After a patch upgrade the retained assets are of the older patch.
  const assets = [{ home: current.neo4jHome, version: current.neo4jVersion }, current.previousNeo4jAsset].filter(Boolean);
  for (const { home, version } of assets) {
    if (typeof home !== 'string' || typeof version !== 'string') throw new Error('Neo4j asset home or version is missing.');
    await assertManagedNeo4jHome(paths, home, version);
  }
  const versions = [...new Set(assets.map(({ version }) => version))];
  const defaultHomes = await Promise.all(versions.map(version =>
    assertManagedNeo4jHome(paths, join(paths.nativeRuntimeDir, `neo4j-community-${version}`), version)));
  return [...new Set([...defaultHomes, ...await managedNeo4jContainers(paths, versions, { leftovers }),
    ...assets.map(({ home }) => assetContainer(paths, resolve(home)))])];
}

// Normal setup/start/stop/admin work shares the exclusive lifecycle lease. Only
// the operation that already owns the lease may reenter while switching assets.
// [operation] names what takes it (start, stop), so a later start knows what an
// interrupted holder left behind (neo4j-lifecycle-lock.js); [holder] is what
// else the lock records for a recovery.
export async function withNativeAssetOperation(paths, env, action, options = {}) {
  const lock = await takeNativeAssetOperation(paths, env, options);
  if (!lock) return action(env);
  try { return await action({ ...env, FULI_NATIVE_ASSET_OPERATION: lock.token }); }
  finally { await lock.release(); }
}

// The lease itself, for an operation that holds it across several steps and
// releases it only once they leave the runtime whole (an import: graph-backup.js);
// null when [env] already holds it (its token re-enters).
export async function takeNativeAssetOperation(paths, env, { operation = 'start', identity, holder } = {}) {
  const root = paths.nativeRuntimeDir;
  await releaseAbandonedNeo4jLifecycleLock(root, identity);
  try {
    const owner = await readFile(join(root, '.neo4j-lifecycle.lock', 'owner'), 'utf8');
    if (owner && env.FULI_NATIVE_ASSET_OPERATION === owner) return null;
    throw await neo4jLifecycleLockError(root, identity);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (await journalExists(root)) throw await neo4jLifecycleLockError(root, identity);
  const lock = await acquireNeo4jLifecycleLock(root, { operation, details: holder });
  if (await journalExists(root)) {
    const error = await neo4jLifecycleLockError(root, identity);
    await lock.release();
    throw error;
  }
  return lock;
}

async function journalExists(root) {
  try { await lstat(join(root, 'neo4j-transaction.json')); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
