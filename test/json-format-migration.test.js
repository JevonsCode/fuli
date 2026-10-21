import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { EXTERNAL_KNOWLEDGE_FORMAT, ExternalKnowledgeRegistry } from '../src/external-knowledge/registry.js';
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
  { code: 'data_format_changed_since', message: /fuli migrate restore/ });
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
    message: /neither as it was nor as that change left it.*restore it from format-backups\// });
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
