import { sha256Bytes } from '../../security/digest.js';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireFileLock } from '../../storage/file-lock.js';
import { writeTextFileAtomic } from '../../storage/json-file.js';
import { readClientPackState, writeClientPackState, installedClientPacks } from './client-pack-store.js';
import { loadClientDescriptorPacks } from './descriptor-packs.js';
import { previewClientConfiguration } from './config-preview.js';
import { compareSemanticVersions } from '../../semantic-version.js';

export async function changeClientPack({ dataDir, pack, rollback = false, agent, context, confirm, write,
  writeFile = writeTextFileAtomic }) {
  const builtin = loadClientDescriptorPacks().find(value => value.id === pack.id);
  loadClientDescriptorPacks({ trustedOverrides: [pack] });
  write(`Built-in descriptor:\n${JSON.stringify(builtin, null, 2)}\nProposed descriptor:\n${JSON.stringify(pack, null, 2)}`);
  if (!await confirm(`Install ${pack.id}@${pack.version}? [y/N] `, { defaultYes: false })) return { status: 'cancelled' };
  const release = acquireFileLock(join(dataDir, '.client-pack-operation.lock'));
  try {
    const state = readClientPackState(dataDir);
    if (state.ledger.some(entry => (entry.status === 'pending' || entry.restoreFailures?.length))) throw new Error('An interrupted client update needs recovery: run fuli clients rollback ID');
    const current = installedClientPacks(dataDir).find(value => value.id === pack.id);
    if (!rollback && compareSemanticVersions(pack.version, current.version) <= 0) return { status: 'current' };
    if (compareSemanticVersions(pack.version, builtin.version) < 0) throw new TypeError('Rollback cannot go below the built-in version');
    const key = `${pack.id}@${pack.version}`;
    if (state.packages[key] && state.packages[key].digest !== pack.digest) throw new TypeError('Installed version has different content');
    const operation = randomUUID();
    const changes = agent ? previewClientConfiguration(pack, agent, context) : [];
    const accepted = [];
    for (const [index, change] of changes.entries()) {
      const backupPath = join(dataDir, 'backups', 'client-packs', operation, `${index}.bak`);
      write(`File: ${change.path}\nBackup: ${backupPath}\n--- before\n${change.before ?? '(absent)'}\n+++ after\n${change.after}`);
      if (await confirm(`Write ${change.path}? [y/N] `, { defaultYes: false })) accepted.push({ ...change, backupPath });
    }
    for (const change of accepted) {
      const actual = existsSync(change.path) ? readFileSync(change.path, 'utf8') : null;
      if (actual !== change.before) throw new Error(`Client file changed during review: ${change.path}`);
    }
    const next = structuredClone(state);
    next.packages[key] = pack;
    next.history[pack.id] = rollback ? (state.history[pack.id] ?? []).slice(0, -1) : [...(state.history[pack.id] ?? []), current];
    next.active[pack.id] = key;
    // Persist every backup before the journal. Until the final atomic state write,
    // readers keep the previous active pack; interruption is visible on the next CLI call.
    const files = accepted.map(change => {
      if (change.before !== null) writeTextFileAtomic(change.backupPath, change.before, { durable: true });
      return { path: change.path, backupPath: change.backupPath,
        beforeDigest: change.before === null ? null : sha256Bytes(change.before), afterDigest: sha256Bytes(change.after) };
    });
    const pending = { operation, id: pack.id, from: current.version, to: pack.version, status: 'pending', rollback, files };
    const staged = structuredClone(state);
    staged.packages[key] = pack;
    staged.ledger.push(pending);
    writeClientPackState(dataDir, staged);
    const written = [];
    try {
      for (const [index, change] of accepted.entries()) {
        const actual = existsSync(change.path) ? readFileSync(change.path, 'utf8') : null;
        if (actual !== change.before) throw new Error(`Client file changed during apply: ${change.path}`);
        written.push({ ...change, ...files[index] });
        writeFile(change.path, change.after, { beforeReplace: () => assertClientContent(change.path, change.before) });
      }
      next.ledger.push({ operation, id: pack.id, from: current.version, to: pack.version, status: 'applied', rollback,
        files });
      writeClientPackState(dataDir, next);
    } catch (error) {
      const failures = [];
      for (const change of written.reverse()) {
        try {
          const current = restorationContent(change);
          if (current === undefined) continue;
          if (change.before === null) rmSync(change.path, { force: true });
          else writeFile(change.path, change.before, { durable: true,
            beforeReplace: () => assertClientContent(change.path, current) });
        }
        catch (restoreError) { failures.push(`${change.path}: ${restoreError.message}`); }
      }
      state.ledger.push({ operation, id: pack.id, from: current.version, to: pack.version, status: 'failed', files, restoreFailures: failures });
      writeClientPackState(dataDir, state);
      if (failures.length) throw new AggregateError([error], `Client restoration failed: ${failures.join('; ')}`);
      throw error;
    }
    return { status: 'applied', version: pack.version, files: accepted.length };
  } finally { release(); }
}



// Explicit recovery is a rollback, reviewed file by file. It never overwrites an
// intervening client edit, and the durable journal stays pending until all restores finish.
export async function recoverClientPack({ dataDir, id, confirm, write, writeFile = writeTextFileAtomic }) {
  const release = acquireFileLock(join(dataDir, '.client-pack-operation.lock'));
  try {
    const state = readClientPackState(dataDir);
    const entry = state.ledger.find(item => item.id === id && (item.status === 'pending' || item.restoreFailures?.length));
    if (!entry) return null;
    const restores = [];
    for (const file of entry.files) {
      const current = restorationContent(file);
      if (current === undefined) continue;
      const before = file.beforeDigest === null ? null : readFileSync(file.backupPath, 'utf8');
      if (before !== null && sha256Bytes(before) !== file.beforeDigest) throw new Error(`Recovery backup digest mismatch: ${file.backupPath}`);
      write(`Restore file: ${file.path}\nBackup: ${file.backupPath}\n--- current\n${current}\n+++ restored\n${before ?? '(absent)'}`);
      if (!await confirm(`Restore ${file.path}? [y/N] `, { defaultYes: false })) return { status: 'recovery_required' };
      restores.push({ ...file, before, current });
    }
    for (const file of restores) {
      const current = existsSync(file.path) ? readFileSync(file.path, 'utf8') : null;
      if (current !== file.current) throw new Error(`File changed during recovery review: ${file.path}`);
      if (file.before === null) rmSync(file.path, { force: true });
      else writeFile(file.path, file.before, { durable: true,
        beforeReplace: () => assertClientContent(file.path, file.current) });
    }
    entry.status = 'recovered';
    delete entry.restoreFailures;
    writeClientPackState(dataDir, state);
    return { status: 'recovered', files: restores.length };
  } finally { release(); }
}

function assertClientContent(path, expected) {
  const actual = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (actual !== expected) throw new Error(`Client file changed before replacement: ${path}`);
}

// Both immediate rollback and interrupted-operation recovery compare live bytes.
function restorationContent(file) {
  const current = existsSync(file.path) ? readFileSync(file.path, 'utf8') : null;
  const digest = current === null ? null : sha256Bytes(current);
  if (digest === file.beforeDigest) return undefined;
  if (digest !== file.afterDigest) throw new Error(`Recovery refuses an intervening edit: ${file.path}`);
  return current;
}
