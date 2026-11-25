import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { formatBackupName } from '../packages/roundtable/src/storage/format-backup-names.js';
import { acquireMaintenance } from '../src/data-format/maintenance-lock.js';
import { RunnerHostStore } from '../src/runner/host-store.js';
import { JefaBoardStore } from '../src/employees/builtin/jefa/board-store.js';
import test from 'node:test';

import { inspectLocalStores } from '../src/data-format/local-stores.js';
import { finishProjectGate, freezeProject, gateDirectory, holdBackupOwnership, holdProjectWrites, initializeProjectGate } from '../src/runner/project-write-gate.js';

test('a project freeze drains in-flight writes, survives reopen and leaves other projects writable', t => {
  const path = mkdtempSync(join(tmpdir(), 'fuli-project-gate-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const dir = gateDirectory(path, 'sample');
  for (const key of ['one','two']) initializeProjectGate(dir, key, 'owner', 1);
  const registered = inspectLocalStores(path).filter(store => store.store === 'project-write-gate');
  assert.equal(registered.length, 3);
  assert.ok(registered.every(store => store.version === 1 && store.state === 'current'));
  const freeze = () => freezeProject(dir, 'one', { moveId: 'move', generation: 1, role: 'owner' });
  for (const keys of [['one'], null]) {
    const release = holdProjectWrites(dir, keys);
    try { assert.throws(freeze, { code: 'project_writes_in_flight' }); } finally { release(); }
  }
  const independent = holdProjectWrites(dir, ['two']);
  try { assert.equal(freeze().state, 'closed'); } finally { independent(); }
  assert.equal(freeze().state, 'closed');
  assert.throws(() => holdProjectWrites(dir, ['two','one']), { code: 'project_write_blocked' });
  assert.throws(() => holdProjectWrites(dir, null), { code: 'project_scope_unknown' });
  holdProjectWrites(dir, ['two'])();
  assert.throws(() => finishProjectGate(dir, 'one', { moveId: 'other', generation: 1, role: 'owner', commit: false }));
  const decision = { moveId: 'move', generation: 1, role: 'replica', commit: true };
  assert.equal(finishProjectGate(dir, 'one', decision).generation, 2);
  assert.equal(finishProjectGate(dir, 'one', decision).generation, 2);
  assert.throws(() => holdProjectWrites(dir, ['one']), { code: 'project_write_blocked' });
  freezeProject(dir, 'one', { moveId: 'bring-back', generation: 2, role: 'replica' });
  finishProjectGate(dir, 'one', { moveId: 'bring-back', generation: 2, role: 'owner', commit: true });
  assert.throws(() => holdProjectWrites(dir, ['one'], 1), { code: 'project_generation_changed' });
  holdProjectWrites(dir, ['one'], 3)();
  holdProjectWrites(dir, null)();
});
test('process exit releases an in-flight write, but leaves a committed freeze in force', async t => {
  const path = mkdtempSync(join(tmpdir(), 'fuli-gate-crash-'));
  const dir = gateDirectory(path, 'sample-space');
  const settings = { moveId: 'move', generation: 1, role: 'owner' };
  const module = new URL('../src/runner/project-write-gate.js', import.meta.url).href;
  initializeProjectGate(dir, 'sample', 'owner', 1);
  const file = join(path, 'holder.mjs');
  writeFileSync(file, `import { holdProjectWrites, freezeProject } from ${JSON.stringify(module)};
    const [dir, mode] = process.argv.slice(2);
    if (mode === 'write') holdProjectWrites(dir, ['sample']);
    else freezeProject(dir, 'sample', ${JSON.stringify(settings)});
    process.send('ready');
    setInterval(() => {}, 1000);`);
  t.after(() => rmSync(path, { recursive: true, force: true }));
  for (const mode of ['write', 'freeze']) {
    const child = fork(file, [dir, mode], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const closed = once(child, 'exit');
    try {
      await Promise.race([once(child, 'message'), closed.then(() => { throw new Error('child exited before acquiring its gate'); })]);
      if (mode === 'write') assert.throws(() => freezeProject(dir, 'sample', settings), { code: 'project_writes_in_flight' });
      else assert.throws(() => holdProjectWrites(dir, ['sample']), { code: 'project_write_blocked' });
    } finally { child.kill('SIGKILL'); await closed; }
  }
  assert.throws(() => holdProjectWrites(dir, ['sample']), { code: 'project_write_blocked' });
});

test('a backup receipt binds the device and generations and serializes a move during restore', t => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-gate-backup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'runner'));
  writeFileSync(join(root, 'runner', 'project-registry.json'), JSON.stringify({ version: 1, spaceId: 'space',
    device: 'a'.repeat(64), authority: 'a'.repeat(64) }));
  const dir = gateDirectory(root, 'space');
  initializeProjectGate(dir, 'one', 'owner', 1);
  const guard = holdBackupOwnership(root, false);
  const move = { moveId: 'move', generation: 1, role: 'owner' };
  try { assert.throws(() => freezeProject(dir, 'one', move), { code: 'project_writes_in_flight' }); }
  finally { guard.release(); }
  holdBackupOwnership(root, true, guard.digest).release();
  initializeProjectGate(dir, 'later', 'owner', 1);
  holdBackupOwnership(root, true, guard.digest, guard.rows).release();
  assert.throws(() => holdBackupOwnership(root, true, guard.digest, []), { code: 'backup_project_generation_changed' });
  assert.throws(() => holdBackupOwnership(root, true, guard.digest), { code: 'backup_project_generation_changed' });
  freezeProject(dir, 'one', move);
  assert.throws(() => holdBackupOwnership(root, true, guard.digest), { code: 'project_move_in_progress' });
  finishProjectGate(dir, 'one', { ...move, role: 'replica', commit: true });
  assert.throws(() => holdBackupOwnership(root, true, guard.digest, guard.rows), { code: 'backup_project_generation_changed' });
});

test('store restore preserves protected board history while allowing independent local changes', t => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-protected-restore-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'runner'));
  writeFileSync(join(root, 'runner', 'project-registry.json'), JSON.stringify({ version: 1, spaceId: 'space',
    device: 'a'.repeat(64), authority: 'b'.repeat(64) }));
  const gates = gateDirectory(root, 'space');
  initializeProjectGate(gates, 'moved', 'replica', 2);
  initializeProjectGate(gates, 'local', 'owner', 1);
  const label = 'employees/data/jefa/board.sqlite';
  const path = join(root, label);
  function sharing(projectId, enabled) {
    const db = new JefaBoardStore(path);
    try { db.setSharing({ spaceId: 'space', projectId }, enabled); }
    finally { db.close(); }
  }
  sharing('moved', true);
  const dir = dirname(path);
  mkdirSync(join(dir, 'format-backups'));
  const ref = 'format-backups/' + formatBackupName(path, 1, new Date(), 'sqlite');
  copyFileSync(path, join(dir, ref));
  sharing('local', true);
  acquireMaintenance(root, label, ref)();
  acquireMaintenance(root, 'agent-apps/registry.sqlite', 'unrelated')();
  sharing('moved', false);
  assert.throws(() => acquireMaintenance(root, label, ref), { code: 'restore_project_control_changed' });
});


test('restoring a host registry before local enrollment cannot roll back a verified owner', t => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-authority-restore-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const label = 'runner/host.sqlite';
  const file = join(root, label);
  const open = () => new RunnerHostStore(file, { spaceId: () => 'space' });
  const first = open();
  void first.db;
  first.close();
  mkdirSync(join(dirname(file), 'format-backups'));
  const ref = 'format-backups/' + formatBackupName(file, 1, new Date(), 'sqlite');
  copyFileSync(file, join(dirname(file), ref));
  acquireMaintenance(root, label, ref)();
  const current = open();
  try { assert.equal(current.ownership().verified('a'.repeat(64), ['one']).ok, true); }
  finally { current.close(); }
  assert.throws(() => acquireMaintenance(root, label, ref), { code: 'restore_project_control_changed' });
});
