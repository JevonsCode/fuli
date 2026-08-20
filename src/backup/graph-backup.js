import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
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
    try {
      for (const entry of manifest.instances) {
        await adapter.load(entry.id, join(source, entry.file), { rollback: false });
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
      let rollbackError = null;
      for (const entry of rollbackEntries) {
        try {
          await adapter.load(entry.id, entry.path, { rollback: true });
        } catch (caught) {
          rollbackError ??= caught;
        }
      }
      if (rollbackError) {
        throw new AggregateError([error, rollbackError],
          'Graph import failed and its automatic rollback was incomplete.');
      }
      throw error;
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
    if (lifecycle?.resume === true) await adapter.start(lifecycle);
  }
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

function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}
