import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanupRuntime } from '../acceptance/handoff-live/runtime.js';

test('private fixture files are removed even if Docker cannot run during cleanup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-handoff-cleanup-'));
  await writeFile(join(directory, 'credential.private.json'), 'synthetic secret');
  const primary = new Error('Original client failed');
  await cleanupRuntime(async () => { throw new Error('Docker missing'); }, directory, 'fuli-handoff-fixture', primary);
  assert.equal(existsSync(directory), false);
  assert.match(primary.message, /^Original client failed; Cleanup failed/);
});

test('Docker cleanup failure prevents a successful acceptance result', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-handoff-cleanup-'));
  await assert.rejects(cleanupRuntime(async () => ({ code: 1 }), directory, 'fuli-handoff-fixture'), /Cleanup failed/);
  assert.equal(existsSync(directory), false);
});
