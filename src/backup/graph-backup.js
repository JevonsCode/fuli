import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { FULI_VERSION } from '../package-metadata.js';
import { GRAPH_STATE } from './graph-import-states.js';
import { sha256File } from '../security/digest.js';

const BACKUP_FORMAT = 'fuli-neo4j-backup';
const BACKUP_VERSION = 1;

export async function exportGraphData({
  outputDir,
  sourceMode,
  instances,
  adapter,
  now = () => new Date()
}) {
  const destination = requiredPath(outputDir, 'Backup output directory');
  validateMode(sourceMode, 'sourceMode');
  const selectedInstances = validateInstances(instances);
  assertAdapter(adapter, ['stop', 'dump', 'start']);
  if (await pathExists(destination)) {
    throw new Error('Backup output already exists; choose a new directory.');
  }
  await mkdir(dirname(destination), { recursive: true });
  const partial = `${destination}.partial-${randomUUID()}`;
  await mkdir(partial, { recursive: false, mode: 0o700 });
  let lifecycle = null;
  let published = false;
  try {
    lifecycle = await adapter.stop();
    const exported = [];
    for (const id of selectedInstances) {
      const file = `${id}.dump`;
      const path = join(partial, file);
      await adapter.dump(id, path);
      await chmod(path, 0o600);
      exported.push({ id, file, sha256: await sha256File(path) });
    }
    const manifest = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      createdAt: now().toISOString(),
      sourceMode,
      fuliVersion: FULI_VERSION,
      instances: exported,
      ...(typeof adapter.selection === 'function'
        ? selectionProperty(await adapter.selection())
        : {})
    };
    const manifestPath = join(partial, 'manifest.json');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await rename(partial, destination);
    published = true;
    return {
      status: 'exported',
      outputDir: destination,
      sourceMode,
      instances: selectedInstances
    };
  } finally {
    if (!published) await rm(partial, { recursive: true, force: true });
    if (lifecycle?.resume === true) await adapter.start(lifecycle);
  }
}

export async function importGraphData({
  inputDir,
  targetMode,
  rollbackDir,
  adapter,
  now = () => new Date()
}) {
  const source = requiredPath(inputDir, 'Backup input directory');
  const rollbackBase = requiredPath(rollbackDir, 'Rollback directory');
  validateMode(targetMode, 'targetMode');
  assertAdapter(adapter, ['stop', 'dump', 'load', 'start']);
  const manifest = await readGraphBackupManifest(source);
  await verifyBackupFiles(source, manifest);
  if (
    Array.isArray(adapter.instances) &&
    manifest.instances.some(({ id }) => !adapter.instances.includes(id))
  ) {
    throw new Error(
      'The target runtime is not configured for every graph instance in this backup.'
    );
  }

  const rollbackRoot = join(
    rollbackBase,
    `before-import-${now().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`
  );
  await mkdir(rollbackRoot, { recursive: true, mode: 0o700 });
  let lifecycle = null;
  const rollbackEntries = [];
  let rollbackReady = false;
  // The one lease this import holds from before it writes its first graph
  // until every graph is whole again (adapter.holdImport; a runtime without
  // one locks nothing). It is kept when that never happens, so nothing starts
  // on a half-written graph: a recovery takes over from what its lock records.
  let lease = null;
  let kept = false;
  try {
    lifecycle = await adapter.stop();
    for (const entry of manifest.instances) {
      if (typeof adapter.hasData === 'function' && !await adapter.hasData(entry.id)) continue;
      const path = join(rollbackRoot, `${entry.id}.dump`);
      await adapter.dump(entry.id, path);
      await chmod(path, 0o600);
      rollbackEntries.push({ id: entry.id, path });
    }
    if (rollbackEntries.length > 0) {
      const rollbackManifest = {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        createdAt: now().toISOString(),
        sourceMode: targetMode,
        fuliVersion: FULI_VERSION,
        reason: 'automatic-pre-import-rollback',
        instances: await Promise.all(rollbackEntries.map(async ({ id, path }) => ({
          id,
          file: basename(path),
          sha256: await sha256File(path)
        })))
      };
      await writeFile(join(rollbackRoot, 'manifest.json'),
        `${JSON.stringify(rollbackManifest, null, 2)}\n`, { mode: 0o600 });
      rollbackReady = true;
    } else {
      await rm(rollbackRoot, { recursive: true, force: true });
    }
    // What a recovery of an import killed part way goes back to (neo4j-recovery.js):
    // this copy (null when every instance was empty before), which instances it
    // holds, and which this import overwrites.
    const restorePoint = { path: rollbackReady ? rollbackRoot : null,
      instances: rollbackEntries.map(({ id }) => id), loading: manifest.instances.map(({ id }) => id) };
    // Where this import stands with each graph (graph-import-states.js), in the
    // lock before that graph is written and again once it is written, failed
    // or back, so a recovery or abandoning the import never guesses. A state
    // that could not be recorded (a full disk) stops the import where it is:
    // nothing more is written, and the lock stays.
    const graphStates = Object.fromEntries(manifest.instances.map(({ id }) => [id, GRAPH_STATE.untouched]));
    lease = typeof adapter.holdImport === 'function'
      ? await adapter.holdImport({ restorePoint, graphStates: { ...graphStates } })
      : UNLOCKED;
    let unrecorded = null;
    const mark = async (changes) => {
      if (unrecorded) throw unrecorded;
      Object.assign(graphStates, changes);
      try { await lease.record({ graphStates: { ...graphStates } }); }
      catch (error) { unrecorded = error; throw error; }
    };
    try {
      for (const entry of manifest.instances) {
        await mark({ [entry.id]: GRAPH_STATE.writing });
        await adapter.load(entry.id, join(source, entry.file));
        await mark({ [entry.id]: GRAPH_STATE.imported });
      }
      if (typeof adapter.reconcile === 'function') {
        await adapter.reconcile({
          selection: manifest.selection ?? {},
          sourceMode: manifest.sourceMode,
          targetMode,
          lifecycle
        });
      }
    } catch (error) {
      // Every graph this import wrote goes back: from the copy when it had
      // data before, or emptied again when it had none (adapter.setAside).
      // Graphs it never wrote stay as they are.
      let rollbackError = null;
      let restoreError = null;
      if (!unrecorded) {
        try {
          const touched = Object.keys(graphStates).filter(id => graphStates[id] !== GRAPH_STATE.untouched);
          const failed = touched.filter(id => graphStates[id] === GRAPH_STATE.writing);
          if (failed.length) await mark(Object.fromEntries(failed.map(id => [id, GRAPH_STATE.importFailed])));
          for (const id of touched) {
            const copy = rollbackEntries.find(entry => entry.id === id);
            if (!copy && typeof adapter.setAside !== 'function') {
              rollbackError ??= new Error(`The ${id} graph was empty before the import and this runtime cannot empty it again.`);
              continue;
            }
            await mark({ [id]: GRAPH_STATE.restoring });
            try {
              if (copy) await adapter.load(id, copy.path);
              else await adapter.setAside(id);
            } catch (caught) {
              rollbackError ??= caught;
              if (copy) restoreError ??= caught;
              await mark({ [id]: GRAPH_STATE.restoreFailed });
              continue;
            }
            await mark({ [id]: GRAPH_STATE.restored });
          }
          // Every graph is back: a recovery of an import killed from here on
          // only releases the lock (load-recovery.js).
          if (!rollbackError) await lease.record({ restored: true });
        } catch (caught) {
          unrecorded ??= caught;
        }
      }
      if (!unrecorded && !rollbackError) throw rolledBack(error);
      kept = true;
      if (!unrecorded && restoreError) await lease.restoreFailed?.(rollbackRoot, restoreError).catch(() => {});
      throw incompleteImport(error, unrecorded ?? rollbackError, {
        unrecorded: Boolean(unrecorded), locked: lease.locked, copy: rollbackReady ? rollbackRoot : null });
    }
    return {
      status: 'imported',
      inputDir: source,
      targetMode,
      instances: manifest.instances.map(({ id }) => id),
      rollbackDir: rollbackReady ? rollbackRoot : null
    };
  } catch (error) {
    if (!rollbackReady) await rm(rollbackRoot, { recursive: true, force: true });
    throw error;
  } finally {
    // Only with every graph whole: the lease goes, and what ran before starts again.
    if (!kept) {
      await lease?.release();
      if (lifecycle?.resume === true) await adapter.start(lifecycle);
    }
  }
}

// A runtime whose imports hold no lock (containers, and native outside macOS).
const UNLOCKED = Object.freeze({ locked: false, record: async () => {}, release: async () => {} });

const RECOVER = 'fuli graph runtime recover';

// An import that failed and whose rollback brought every graph back.
function rolledBack(error) {
  const detail = error?.message ?? String(error);
  return new Error(`导入没有成功：${detail}。每个图谱都已退回导入前的数据。`
    + ` / Graph import failed: ${detail}. Every graph is back to its data from before the import.`, { cause: error });
}

// An import that failed and left a graph that may be half written: its
// rollback did not finish ([cause]), or a graph's state could not be recorded
// in the lock ([unrecorded]), so nothing more was written. With the lock kept
// ([locked]), starts are refused until a recovery brings the graphs back.
function incompleteImport(error, cause, { unrecorded, locked, copy }) {
  const detail = error?.message ?? String(error);
  const why = cause === error ? '' : cause?.message ?? String(cause);
  const [stopped, stoppedEn] = unrecorded
    ? [`没能把各图谱的进度记进数据库维护锁${why ? `（${why}）` : ''}，所以没有接着写，也没有退回`,
      `the progress of each graph could not be recorded in the maintenance lock${why ? ` (${why})` : ''}, so nothing more was written or rolled back`]
    : [`自动退回没有做完（${why}）`, `its automatic rollback did not finish (${why})`];
  const [hold, holdEn] = locked
    ? [`维护锁留着，FULI 不会在写了一半的图谱上启动。运行 ${RECOVER}：它先说明怎样把图谱恢复到导入前，确认后再做。`,
      `The maintenance lock is kept, so FULI does not start on a half-written graph. Run \`${RECOVER}\`: it says how it brings the graphs back to before the import, and does it once you confirm.`]
    : ['图服务没有重新启动；把图谱导回之前不要启动 FULI。', 'The graph services were not started again; do not start FULI before the graph is brought back.'];
  const [back, backEn] = copy
    ? [`导入前的副本在 ${copy}，也可以用 fuli graph import --input "${copy}" --yes 导回。`,
      ` The graph from before the import is kept at ${copy}; it can also be brought back with: fuli graph import --input "${copy}" --yes`]
    : ['', ''];
  return Object.assign(new AggregateError([error, cause], `导入没有成功：${detail}；${stopped}。${hold}${back}`
    + ` / Graph import failed: ${detail}; ${stoppedEn}. ${holdEn}${backEn}`), { code: 'graph_import_incomplete', lockKept: locked });
}

export async function readGraphBackupManifest(inputDir) {
  const root = requiredPath(inputDir, 'Backup input directory');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  } catch (error) {
    throw new Error('Backup manifest is missing or invalid.', { cause: error });
  }
  if (manifest?.format !== BACKUP_FORMAT || manifest.version !== BACKUP_VERSION) {
    throw new Error('Backup format or version is not supported.');
  }
  validateMode(manifest.sourceMode, 'backup source mode');
  validateManifestInstances(manifest.instances);
  validateSelection(manifest.selection);
  return manifest;
}

// A backup's manifest, once every file it names matches its checksum.
export async function readVerifiedGraphBackup(inputDir) {
  const manifest = await readGraphBackupManifest(inputDir);
  await verifyBackupFiles(inputDir, manifest);
  return manifest;
}

async function verifyBackupFiles(root, manifest) {
  for (const entry of manifest.instances) {
    const actual = await sha256File(join(root, entry.file));
    if (actual !== entry.sha256) {
      throw new Error(`Backup checksum validation failed for ${entry.id}.`);
    }
  }
}

function validateManifestInstances(instances) {
  if (!Array.isArray(instances) || instances.length === 0) {
    throw new Error('Backup manifest does not contain graph instances.');
  }
  const ids = validateInstances(instances.map(({ id }) => id));
  if (ids.length !== instances.length) throw new Error('Backup instances are invalid.');
  for (const entry of instances) {
    if (
      entry.file !== `${entry.id}.dump` ||
      basename(entry.file) !== entry.file ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      throw new Error(`Backup entry for ${entry.id} is invalid.`);
    }
  }
}

function validateSelection(selection) {
  if (selection === undefined) return;
  if (
    !selection ||
    typeof selection !== 'object' ||
    Object.keys(selection).some((key) => key !== 'personalSpaceId') ||
    typeof selection.personalSpaceId !== 'string' ||
    !selection.personalSpaceId.trim() ||
    selection.personalSpaceId.length > 200 ||
    /[\s\u0000-\u001f\u007f]/u.test(selection.personalSpaceId)
  ) {
    throw new Error('Backup personal-space selection is invalid.');
  }
}

function selectionProperty(selection) {
  if (selection == null) return {};
  validateSelection(selection);
  return { selection };
}

function validateInstances(instances) {
  if (!Array.isArray(instances) || instances.length === 0) {
    throw new TypeError('At least one graph instance is required.');
  }
  const normalized = [...new Set(instances)];
  if (
    normalized.length !== instances.length ||
    normalized.some((id) => !['personal', 'workspace'].includes(id))
  ) {
    throw new TypeError('Graph instances must be unique personal or workspace entries.');
  }
  return normalized;
}

function validateMode(mode, label) {
  if (!['container', 'native'].includes(mode)) {
    throw new TypeError(`${label} must be container or native.`);
  }
}

function assertAdapter(adapter, methods) {
  if (!adapter || methods.some((method) => typeof adapter[method] !== 'function')) {
    throw new TypeError('A complete graph backup runtime adapter is required.');
  }
}

function requiredPath(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required.`);
  return resolve(value);
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
