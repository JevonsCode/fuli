import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmdirSync,
  unlinkSync
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export function planMigrationDestination(destinationPath) {
  const destination = resolve(destinationPath);
  if (existsSync(destination)) {
    return {
      destination,
      storePath: destination,
      ownsStorePath: false,
      createdParents: []
    };
  }

  const parent = dirname(destination);
  const createdParents = createParents(parent);
  try {
    return {
      destination,
      storePath: reserveTemporaryPath(destination),
      ownsStorePath: true,
      createdParents
    };
  } catch (error) {
    removeEmptyParents(createdParents);
    throw error;
  }
}

export function publishMigrationDestination(plan) {
  if (!plan.ownsStorePath) return;

  try {
    linkSync(plan.storePath, plan.destination);
  } catch (error) {
    if (existsSync(plan.destination)) {
      throw new Error(
        `Migration destination appeared while the import was running: ${plan.destination}`,
        { cause: error }
      );
    }
    throw new Error(`Unable to publish migrated SQLite database: ${error.message}`, {
      cause: error
    });
  }
}

export function cleanupMigrationDestination(plan) {
  if (!plan.ownsStorePath) return;

  const errors = [];
  for (const artifact of ownedArtifacts(plan.storePath)) {
    try {
      unlinkSync(artifact);
    } catch (error) {
      if (error.code !== 'ENOENT') errors.push(error);
    }
  }
  removeEmptyParents(plan.createdParents, errors);

  if (errors.length > 0) {
    throw new AggregateError(errors, `Unable to clean migration temporary database: ${plan.storePath}`);
  }
}

function reserveTemporaryPath(destination) {
  const temporaryPath = join(
    dirname(destination),
    `.${basename(destination)}.${randomUUID()}.migration`
  );
  const descriptor = openSync(temporaryPath, 'wx');
  closeSync(descriptor);
  return temporaryPath;
}

function createParents(parent) {
  const firstCreated = mkdirSync(parent, { recursive: true });
  if (firstCreated === undefined) return [];

  const parents = [];
  const boundary = comparablePath(firstCreated);
  let current = parent;
  while (true) {
    parents.push(current);
    if (comparablePath(current) === boundary) return parents;
    current = dirname(current);
  }
}

function removeEmptyParents(parents, errors = []) {
  for (const parent of parents) {
    try {
      if (readdirSync(parent).length === 0) rmdirSync(parent);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') errors.push(error);
    }
  }
}

function ownedArtifacts(storePath) {
  return [`${storePath}-wal`, `${storePath}-shm`, storePath];
}

function comparablePath(path) {
  const resolved = resolve(path).replace(/^\\\\\?\\/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
