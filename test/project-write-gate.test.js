import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { finishProjectGate, freezeProject, gateDirectory, holdBackupOwnership, holdProjectWrites, initializeProjectGate } from '../src/runner/project-write-gate.js';

test('a project freeze drains in-flight writes, survives reopen and leaves other projects writable', t => {
  const path = mkdtempSync(join(tmpdir(), 'fuli-project-gate-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const dir = gateDirectory(path, 'sample');
  for (const key of ['one','two']) initializeProjectGate(dir, key, 'owner', 1);
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
  freezeProject(dir, 'one', move);
  assert.throws(() => holdBackupOwnership(root, true, guard.digest), { code: 'project_move_in_progress' });
  finishProjectGate(dir, 'one', { ...move, role: 'replica', commit: true });
  assert.throws(() => holdBackupOwnership(root, true, guard.digest), { code: 'backup_project_generation_changed' });
});
