import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { EXTERNAL_KNOWLEDGE_FORMAT, ExternalKnowledgeRegistry } from '../src/external-knowledge/registry.js';
import { inspectJsonStore, refusePendingJsonMigration, writeVersionedJsonFileAtomic } from '../src/storage/json-format.js';
import {
  applyConfirmedJsonMigration, describeJsonRestore, jsonBackupFiles, previewJsonMigration, recoverJsonFile,
  restoreJsonFile, rollbackJsonMigration, undoableJsonMigrations
} from '../src/storage/json-format-migration.js';

// rec#17 D-09 part 2 for a FULI JSON data file: the external-knowledge
// registry an earlier FULI wrote at version 1. Synthetic bindings only.
const CLI = { entrypoint: 'cli' };

function legacyRegistry(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-json-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'bindings.json');
  writeFileSync(path, JSON.stringify({ version: 1, bindings: ['b-1', 'b-2'].map((id) => ({
    id, name: `Secret wiki ${id}`, connectorType: 'mcp', connectorConfig: {}, source: {},
    target: { personalSpaceId: 'space', personalProjectId: 'project' }, mode: 'live', status: 'ready' })) }));
  return { directory, path };
}

const backups = (directory) => existsSync(join(directory, 'format-backups'))
  ? readdirSync(join(directory, 'format-backups')) : [];

test('preview names the bindings by ID and changes nothing', (t) => {
  const { directory, path } = legacyRegistry(t);
  const before = readFileSync(path);

  const plan = previewJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT);

  assert.equal(plan.action, 'apply');
  assert.deepEqual(plan.step, { id: 'external-knowledge/2-binding-targets',
    summary: 'each binding’s single project target becomes a list of targets', kind: 'rewrite', fromVersion: 1,
    toVersion: 2, count: 2, sampleIds: ['b-1', 'b-2'], scopeDigest: plan.step.scopeDigest });
  assert.doesNotMatch(JSON.stringify(plan), /Secret wiki/);
  assert.deepEqual(readFileSync(path), before);
  assert.deepEqual(backups(directory), []);
});

test('apply rewrites the file after a backup and the registry accepts writes again', (t) => {
  const { directory, path } = legacyRegistry(t);
  const plan = previewJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT);
  const registry = new ExternalKnowledgeRegistry(path);
  assert.throws(() => registry.delete('b-1'), { code: 'data_format_pending' });

  const result = applyConfirmedJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT, { digest: plan.digest, actor: CLI });

  assert.deepEqual([result.status, result.count], ['applied', 2]);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, 2);
  assert.equal(JSON.parse(readFileSync(join(directory, result.backupRef), 'utf8')).version, 1);
  assert.equal(registry.delete('b-1'), true);
  assert.equal(previewJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT), null);
  assert.equal(applyConfirmedJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT, { digest: plan.digest, actor: CLI }).status,
    'already_applied');
});

test('a stale preview or a failed backup changes nothing', (t) => {
  const { directory, path } = legacyRegistry(t);
  const plan = previewJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT);

  assert.throws(() => applyConfirmedJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT, { digest: plan.digest, actor: CLI,
    copy: () => { throw new Error('disk full'); } }), { code: 'data_format_backup_failed', message: /disk full/ });
  const document = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(document.version, 1);
  document.bindings.push({ ...document.bindings[0], id: 'b-3' });
  writeFileSync(path, JSON.stringify(document));
  const before = readFileSync(path);

  assert.throws(() => applyConfirmedJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT, { digest: plan.digest, actor: CLI }),
    { code: 'data_format_stale_preview' });
  assert.deepEqual(readFileSync(path), before);
  assert.deepEqual(backups(directory), []);
});

test('two processes applying the same confirmation rewrite the file once', async (t) => {
  const { path } = legacyRegistry(t);
  const plan = previewJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT);
  const script = `import { EXTERNAL_KNOWLEDGE_FORMAT } from ${JSON.stringify(new URL('../src/external-knowledge/registry.js', import.meta.url).href)};
    import { applyConfirmedJsonMigration } from ${JSON.stringify(new URL('../src/storage/json-format-migration.js', import.meta.url).href)};
    process.stdout.write(applyConfirmedJsonMigration(process.argv[1], EXTERNAL_KNOWLEDGE_FORMAT,
      { digest: process.argv[2], actor: { entrypoint: 'cli' } }).status);`;
  const run = () => new Promise((resolve) => {
    let output = '';
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, path, plan.digest]);
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('exit', () => resolve(output));
  });

  assert.deepEqual((await Promise.all([run(), run()])).sort(), ['already_applied', 'applied']);
  assert.equal(jsonBackupFiles(path).length, 1);
});

test('undo restores the earlier file only while it is what the migration wrote', (t) => {
  const { directory, path } = legacyRegistry(t);
  const original = JSON.parse(readFileSync(path, 'utf8'));
  const plan = previewJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT);
  applyConfirmedJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT, { digest: plan.digest, actor: CLI });
  assert.deepEqual(undoableJsonMigrations(path, EXTERNAL_KNOWLEDGE_FORMAT).map((entry) => entry.migrationId),
    ['external-knowledge/2-binding-targets']);

  const undone = rollbackJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT,
    { migrationId: 'external-knowledge/2-binding-targets', actor: CLI });

  assert.deepEqual([undone.status, undone.version], ['rolled_back', 1]);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), original);
  assert.deepEqual(undoableJsonMigrations(path, EXTERNAL_KNOWLEDGE_FORMAT), []);
  assert.equal(backups(directory).length, 2);

  // Applied again, then changed by an ordinary write: undo would lose it.
  const again = previewJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT);
  applyConfirmedJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT, { digest: again.digest, actor: CLI });
  new ExternalKnowledgeRegistry(path).delete('b-2');
  const before = readFileSync(path);
  assert.throws(() => rollbackJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT,
    { migrationId: 'external-knowledge/2-binding-targets', actor: CLI }),
  { code: 'data_format_changed_since', message: /a whole-store restore/ });
  assert.deepEqual(readFileSync(path), before);
});

test('a whole-file restore reports what it discards and keeps the replaced file', (t) => {
  const { directory, path } = legacyRegistry(t);
  const plan = previewJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT);
  const applied = applyConfirmedJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT, { digest: plan.digest, actor: CLI });
  new ExternalKnowledgeRegistry(path).delete('b-2');

  const impact = describeJsonRestore(path, EXTERNAL_KNOWLEDGE_FORMAT, applied.backupRef);
  assert.deepEqual([impact.currentVersion, impact.backupVersion], [2, 1]);
  assert.match(impact.warning, /is lost/);

  const restored = restoreJsonFile(path, EXTERNAL_KNOWLEDGE_FORMAT, { backupRef: applied.backupRef, expected: impact,
    actor: CLI });

  assert.equal(JSON.parse(readFileSync(path, 'utf8')).bindings.length, 2);
  assert.equal(JSON.parse(readFileSync(join(directory, restored.safetyBackupRef), 'utf8')).bindings.length, 1);
  assert.throws(() => restoreJsonFile(path, EXTERNAL_KNOWLEDGE_FORMAT, { backupRef: 'format-backups/../bindings.json',
    expected: impact, actor: CLI }), { code: 'data_format_backup_missing' });
});

const ledgerPath = (path) => `${path}.format-ledger.json`;
const intentPath = (path) => `${path}.format-intent.json`;

test('a newer ledger or intent refuses the migration before the file is touched', (t) => {
  for (const sidecar of [ledgerPath, intentPath]) {
    const { directory, path } = legacyRegistry(t);
    const plan = previewJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT);
    writeFileSync(sidecar(path), JSON.stringify({ version: 2, events: [] }));
    const before = readFileSync(path);

    assert.equal(previewJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT).action, 'blocked');
    assert.throws(() => applyConfirmedJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT, { digest: plan.digest, actor: CLI }),
      { code: 'data_format_blocked' });
    assert.deepEqual(readFileSync(path), before);
    assert.deepEqual(backups(directory), []);
  }
});

// A crash or a full disk at each stage of the commit protocol, then the next operation.
for (const [stage, expected] of [['intent', 'dropped'], ['file', 'completed'], ['ledger', 'completed']]) {
  test(`an apply interrupted after its ${stage} step is ${expected} by the next operation`, (t) => {
    const { path } = legacyRegistry(t);
    const original = readFileSync(path, 'utf8');
    const plan = previewJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT);
    const fault = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });

    assert.throws(() => applyConfirmedJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT, { digest: plan.digest, actor: CLI,
      stage: (name) => { if (name === stage) throw fault; } }), /no space left/);
    assert.ok(existsSync(intentPath(path)), 'the intent survives the interruption');
    // Preview reads, never resolves: it plans on what resolution will leave.
    const preview = previewJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT);
    assert.equal(preview?.digest ?? null, expected === 'dropped' ? plan.digest : null);
    assert.ok(existsSync(intentPath(path)));

    assert.equal(recoverJsonFile(path, EXTERNAL_KNOWLEDGE_FORMAT), expected);
    assert.equal(existsSync(intentPath(path)), false);
    const events = (existsSync(ledgerPath(path)) ? JSON.parse(readFileSync(ledgerPath(path), 'utf8')).events : [])
      .filter((event) => event.status === 'applied');
    if (expected === 'dropped') {
      assert.equal(readFileSync(path, 'utf8'), original);
      assert.deepEqual(events, []);
      assert.equal(applyConfirmedJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT, { digest: plan.digest, actor: CLI }).status,
        'applied');
    } else {
      assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, 2);
      assert.equal(events.length, 1, 'committed exactly once');
      assert.equal(applyConfirmedJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT, { digest: plan.digest, actor: CLI }).status,
        'already_applied');
      assert.equal(undoableJsonMigrations(path, EXTERNAL_KNOWLEDGE_FORMAT).length, 1, 'the undo metadata is there');
    }
  });
}

test('an interrupted change whose file changed otherwise is refused, not guessed', (t) => {
  const { path } = legacyRegistry(t);
  const plan = previewJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT);
  assert.throws(() => applyConfirmedJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT, { digest: plan.digest, actor: CLI,
    stage: (name) => { if (name === 'intent') throw new Error('power cut'); } }), /power cut/);
  writeFileSync(path, JSON.stringify({ version: 1, bindings: [] }));
  const before = readFileSync(path);

  assert.equal(previewJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT).action, 'blocked');
  assert.throws(() => recoverJsonFile(path, EXTERNAL_KNOWLEDGE_FORMAT), { code: 'data_format_interrupted',
    message: /neither as it was nor as that change left it.*Data format migrations/ });
  assert.deepEqual(readFileSync(path), before);
  assert.ok(existsSync(intentPath(path)));
});

test('a restore re-checks the file the person saw and stops if it changed', (t) => {
  const { path } = legacyRegistry(t);
  const plan = previewJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT);
  const applied = applyConfirmedJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT, { digest: plan.digest, actor: CLI });
  const impact = describeJsonRestore(path, EXTERNAL_KNOWLEDGE_FORMAT, applied.backupRef);
  new ExternalKnowledgeRegistry(path).delete('b-2');
  const before = readFileSync(path);

  assert.throws(() => restoreJsonFile(path, EXTERNAL_KNOWLEDGE_FORMAT, { backupRef: applied.backupRef, expected: impact,
    actor: CLI }), { code: 'data_format_stale_preview' });
  assert.deepEqual(readFileSync(path), before);
});

test('an ordinary write after a half-committed apply commits it first, then writes', (t) => {
  const { path } = legacyRegistry(t);
  const plan = previewJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT);
  // The file is written, then the ledger append fails (a full disk).
  assert.throws(() => applyConfirmedJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT, { digest: plan.digest, actor: CLI,
    stage: (name) => { if (name === 'file') throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); } }), /ENOSPC/);
  assert.ok(existsSync(intentPath(path)));

  // A real registry mutation, before any fuli migrate operation runs.
  assert.equal(new ExternalKnowledgeRegistry(path).delete('b-2'), true);

  assert.equal(existsSync(intentPath(path)), false, 'the writer resolved the intent before writing');
  const applied = JSON.parse(readFileSync(ledgerPath(path), 'utf8')).events.filter((event) => event.status === 'applied');
  assert.equal(applied.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).bindings.map((binding) => binding.id), ['b-1']);
  assert.equal(recoverJsonFile(path, EXTERNAL_KNOWLEDGE_FORMAT), null);
  // The registry's own change came after the migration, so undo refuses rather than losing it.
  assert.throws(() => rollbackJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT,
    { migrationId: 'external-knowledge/2-binding-targets', actor: CLI }), { code: 'data_format_changed_since' });
});

test('an ordinary write refuses a file an interrupted change left in conflict', (t) => {
  const { path } = legacyRegistry(t);
  const plan = previewJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT);
  assert.throws(() => applyConfirmedJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT, { digest: plan.digest, actor: CLI,
    stage: (name) => { if (name === 'intent') throw new Error('power cut'); } }), /power cut/);
  writeFileSync(path, JSON.stringify({ version: 2, bindings: [] }));
  const before = readFileSync(path);

  assert.throws(() => new ExternalKnowledgeRegistry(path).put({ id: 'b-9', targets: [] }), { code: 'data_format_interrupted' });
  assert.deepEqual(readFileSync(path), before);
});

test('a conflict the error sends to restore can be restored: describe, confirm, restore', (t) => {
  const { directory, path } = legacyRegistry(t);
  const original = readFileSync(path, 'utf8');
  const plan = previewJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT);
  assert.throws(() => applyConfirmedJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT, { digest: plan.digest, actor: CLI,
    stage: (name) => { if (name === 'intent') throw new Error('power cut'); } }), /power cut/);
  writeFileSync(path, JSON.stringify({ version: 2, bindings: [{ id: 'edited-elsewhere', targets: [] }] }));
  const conflicted = readFileSync(path, 'utf8');
  const [backup] = jsonBackupFiles(path);

  const impact = describeJsonRestore(path, EXTERNAL_KNOWLEDGE_FORMAT, backup.ref);
  const restored = restoreJsonFile(path, EXTERNAL_KNOWLEDGE_FORMAT, { backupRef: backup.ref, expected: impact, actor: CLI });

  assert.equal(readFileSync(path, 'utf8').trim(), JSON.stringify(JSON.parse(original), null, 2));
  assert.equal(existsSync(intentPath(path)), false);
  const events = JSON.parse(readFileSync(ledgerPath(path), 'utf8')).events;
  assert.deepEqual(events.map((event) => event.status), ['restored']);
  assert.match(events[0].detail, /settled an interrupted apply \(external-knowledge\/2-binding-targets\)/);
  assert.equal(readFileSync(join(directory, restored.safetyBackupRef), 'utf8'), conflicted, 'the conflicting file is kept');
});

// The window between "conflict seen" and "restored": a failure at any point
// leaves the file as it was and still refuses ordinary writes.
function conflictedRegistry(t) {
  const fixture = legacyRegistry(t);
  const plan = previewJsonMigration(fixture.path, EXTERNAL_KNOWLEDGE_FORMAT);
  assert.throws(() => applyConfirmedJsonMigration(fixture.path, EXTERNAL_KNOWLEDGE_FORMAT, { digest: plan.digest, actor: CLI,
    stage: (name) => { if (name === 'intent') throw new Error('power cut'); } }), /power cut/);
  writeFileSync(fixture.path, JSON.stringify({ version: 2, bindings: [{ id: 'edited-elsewhere', targets: [] }] }));
  const [backup] = jsonBackupFiles(fixture.path);
  return { ...fixture, backup, impact: describeJsonRestore(fixture.path, EXTERNAL_KNOWLEDGE_FORMAT, backup.ref) };
}

function stillGuarded(path, before) {
  assert.deepEqual(readFileSync(path), before, 'the file is untouched');
  assert.throws(() => new ExternalKnowledgeRegistry(path).put({ id: 'b-9', targets: [] }), { code: 'data_format_interrupted' });
  assert.equal(previewJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT).action, 'blocked');
}

const RESTORE_FAILURES = {
  'a stale confirmation': ({ impact }) => ({ expected: { ...impact, currentDigest: 'f'.repeat(64) } }),
  'a backup that is gone': ({ impact }) => ({ backupRef: 'format-backups/bindings.json.v1-2020-01-01T00-00-00-000Z.json',
    expected: impact }),
  'a safety backup that fails': ({ impact }) => ({ expected: impact, copy: () => { throw new Error('disk full'); } }),
  'an interruption after the safety backup': ({ impact }) => ({ expected: impact,
    stage: (name) => { if (name === 'safety-backup') throw new Error('power cut'); } }),
  'an interruption after the restore intent': ({ impact }) => ({ expected: impact,
    stage: (name) => { if (name === 'intent') throw new Error('power cut'); } })
};

for (const [failure, options] of Object.entries(RESTORE_FAILURES)) {
  test(`settling a conflict survives ${failure}: the file stays guarded and a later restore works`, (t) => {
    const fixture = conflictedRegistry(t);
    const before = readFileSync(fixture.path);

    assert.throws(() => restoreJsonFile(fixture.path, EXTERNAL_KNOWLEDGE_FORMAT, { backupRef: fixture.backup.ref, actor: CLI,
      ...options(fixture) }));

    stillGuarded(fixture.path, before);
    const restored = restoreJsonFile(fixture.path, EXTERNAL_KNOWLEDGE_FORMAT, { backupRef: fixture.backup.ref,
      expected: describeJsonRestore(fixture.path, EXTERNAL_KNOWLEDGE_FORMAT, fixture.backup.ref), actor: CLI });
    assert.equal(restored.status, 'restored');
    assert.equal(JSON.parse(readFileSync(fixture.path, 'utf8')).version, 1);
    assert.equal(existsSync(intentPath(fixture.path)), false);
  });
}

// Another process undoes the migration while this one writes the registry.
function undoInAnotherProcess(path, { holdAfterWriteMs = 0 } = {}) {
  const registry = new URL('../src/external-knowledge/registry.js', import.meta.url).href;
  const engine = new URL('../src/storage/json-format-migration.js', import.meta.url).href;
  // The signal is written synchronously: the child then blocks, holding the lock.
  const script = `import { writeSync } from 'node:fs';
    import { EXTERNAL_KNOWLEDGE_FORMAT } from ${JSON.stringify(registry)};
    import { rollbackJsonMigration } from ${JSON.stringify(engine)};
    const hold = Number(process.argv[2]);
    rollbackJsonMigration(process.argv[1], EXTERNAL_KNOWLEDGE_FORMAT, { migrationId: 'external-knowledge/2-binding-targets',
      actor: { entrypoint: 'cli' }, stage: (name) => {
        if (name === 'file' && hold) {
          writeSync(1, 'undone ');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, hold);
        }
      } });`;
  return spawn(process.execPath, ['--input-type=module', '-e', script, path, String(holdAfterWriteMs)]);
}

const exited = (child) => new Promise((resolve) => child.on('exit', resolve));

test('a registry write computed before another process undid the migration cannot redo it', async (t) => {
  const { path } = legacyRegistry(t);
  const plan = previewJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT);
  applyConfirmedJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT, { digest: plan.digest, actor: CLI });
  // A writer reads v2 and computes its change (paused here, before any lock)...
  const stale = JSON.parse(readFileSync(path, 'utf8'));
  stale.bindings = stale.bindings.filter((binding) => binding.id !== 'b-2');
  // ...another process undoes the migration meanwhile...
  assert.equal(await exited(undoInAnotherProcess(path)), 0);
  const undone = readFileSync(path, 'utf8');
  assert.equal(JSON.parse(undone).version, 1);

  // ...and the writer resumes with its v2 snapshot.
  assert.throws(() => writeVersionedJsonFileAtomic(path, stale, EXTERNAL_KNOWLEDGE_FORMAT),
    { code: 'data_format_pending', message: /at version 1 and an ordinary write would make it 2/ });
  assert.throws(() => new ExternalKnowledgeRegistry(path).delete('b-2'), { code: 'data_format_pending' });
  assert.equal(readFileSync(path, 'utf8'), undone, 'the undone v1 file survives');
});

test('a registry write waits for an undo holding the format lock, then sees v1 and refuses', async (t) => {
  const { path } = legacyRegistry(t);
  const plan = previewJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT);
  applyConfirmedJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT, { digest: plan.digest, actor: CLI });
  const child = undoInAnotherProcess(path, { holdAfterWriteMs: 1500 });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  // Barrier: the other process has written v1 and still holds the lock.
  const deadline = Date.now() + 20_000;
  while (!output.includes('undone')) {
    assert.ok(Date.now() < deadline, `the undo did not start: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const started = Date.now();

  assert.throws(() => new ExternalKnowledgeRegistry(path).put({ id: 'b-9', targets: [] }), { code: 'data_format_pending' });

  assert.ok(Date.now() - started >= 1000, 'the write read the file only once the undo released the lock');
  assert.equal(await exited(child), 0);
  const document = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(document.version, 1);
  assert.deepEqual(document.bindings.map((binding) => binding.id), ['b-1', 'b-2']);
});

// Another process applies the confirmed migration, holding the format lock
// for holdMs after it committed the ledger.
function applyInAnotherProcess(path, digest, { holdMs = 0 } = {}) {
  const registry = new URL('../src/external-knowledge/registry.js', import.meta.url).href;
  const engine = new URL('../src/storage/json-format-migration.js', import.meta.url).href;
  const script = `import { writeSync } from 'node:fs';
    import { EXTERNAL_KNOWLEDGE_FORMAT } from ${JSON.stringify(registry)};
    import { applyConfirmedJsonMigration } from ${JSON.stringify(engine)};
    const hold = Number(process.argv[3]);
    applyConfirmedJsonMigration(process.argv[1], EXTERNAL_KNOWLEDGE_FORMAT, { digest: process.argv[2],
      actor: { entrypoint: 'cli' }, stage: (name) => {
        if (name === 'ledger' && hold) {
          writeSync(1, 'applied ');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, hold);
        }
      } });`;
  return spawn(process.execPath, ['--input-type=module', '-e', script, path, digest, String(holdMs)]);
}

function appliedEvent(path) {
  return JSON.parse(readFileSync(ledgerPath(path), 'utf8')).events.find((event) => event.status === 'applied');
}

test('pending bookkeeping that saw v1 before another process applied records nothing and keeps the applied event', async (t) => {
  const { path } = legacyRegistry(t);
  const plan = previewJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT);
  // This process saw v1 (and would record "pending")...
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, 1);
  // ...another process confirms the apply meanwhile...
  assert.equal(await exited(applyInAnotherProcess(path, plan.digest)), 0);
  const applied = appliedEvent(path);
  assert.ok(applied.applyId && applied.backupRef && applied.afterDigest && applied.planDigest);

  // ...and the bookkeeping resumes.
  assert.equal(refusePendingJsonMigration(path, { format: EXTERNAL_KNOWLEDGE_FORMAT, detail: '2 bindings' }), false);

  const events = JSON.parse(readFileSync(ledgerPath(path), 'utf8')).events;
  assert.deepEqual(events.find((event) => event.status === 'applied'), applied, 'every field of the apply survives');
  assert.equal(events.some((event) => event.status === 'pending_confirmation'), false, 'nothing recorded against v2');
  assert.equal(new ExternalKnowledgeRegistry(path).delete('b-2'), true, 'the change is made on v2');
});

test('pending bookkeeping waits for an apply holding the lock and reads the ledger only after it', async (t) => {
  const { path } = legacyRegistry(t);
  const plan = previewJsonMigration(path, EXTERNAL_KNOWLEDGE_FORMAT);
  // An earlier refusal already put a pending event in the ledger.
  assert.throws(() => new ExternalKnowledgeRegistry(path).delete('b-2'), { code: 'data_format_pending' });
  const child = applyInAnotherProcess(path, plan.digest, { holdMs: 1500 });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + 20_000;
  while (!output.includes('applied')) {
    assert.ok(Date.now() < deadline, `the apply did not start: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const started = Date.now();

  assert.equal(refusePendingJsonMigration(path, { format: EXTERNAL_KNOWLEDGE_FORMAT, detail: 'another detail' }), false);

  assert.ok(Date.now() - started >= 1000, 'it read the file and the ledger only once the apply released the lock');
  assert.equal(await exited(child), 0);
  const statuses = JSON.parse(readFileSync(ledgerPath(path), 'utf8')).events.map((event) => event.status);
  assert.deepEqual(statuses, ['pending_confirmation', 'applied']);
  assert.ok(appliedEvent(path).applyId);
});

test('preview and status show a conflict a settling restore left, before any writer runs', (t) => {
  const fixture = conflictedRegistry(t);
  assert.throws(() => restoreJsonFile(fixture.path, EXTERNAL_KNOWLEDGE_FORMAT, { backupRef: fixture.backup.ref,
    expected: fixture.impact, actor: CLI, stage: (name) => { if (name === 'intent') throw new Error('power cut'); } }),
  /power cut/);
  const before = readFileSync(fixture.path);
  const intent = readFileSync(intentPath(fixture.path));

  // Read only, straight after the failure: the restore's own intent says
  // "dropped", the conflict it settles is what stands.
  assert.equal(previewJsonMigration(fixture.path, EXTERNAL_KNOWLEDGE_FORMAT).action, 'blocked');
  const status = inspectJsonStore(fixture.path, EXTERNAL_KNOWLEDGE_FORMAT);
  assert.equal(status.state, 'half_applied');
  assert.deepEqual(status.steps.map((step) => step.id), ['external-knowledge/2-binding-targets']);
  assert.deepEqual(readFileSync(fixture.path), before);
  assert.deepEqual(readFileSync(intentPath(fixture.path)), intent, 'reading changed no intent');
});
