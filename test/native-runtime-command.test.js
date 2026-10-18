import assert from 'node:assert/strict';
import test from 'node:test';
import { parseNativeRuntimeOptions, runNativeRuntimeCommand } from '../src/cli/native-runtime-command.js';
test('CLI validates actions and requires explicit values without duplicate flags', () => {
  assert.deepEqual(parseNativeRuntimeOptions(['update', '--preview', '--data-dir', '/synthetic']), { action: 'update', preview: true, yes: false, dataDir: '/synthetic' });
  for (const args of [['unknown'], ['update', '--data-dir'], ['update', '--yes', '--yes']]) assert.throws(() => parseNativeRuntimeOptions(args));
});
test('CLI preview and cancelled confirmation never mutate assets', async () => {
  let mutations = 0;
  const deps = { platform: 'darwin', write: () => {}, resolvePaths: () => ({ dataDir: '/synthetic' }),
    plan: async () => ({ neo4jVersion: '5.26.28' }), manage: async () => { mutations++; }, confirm: async () => false };
  assert.equal((await runNativeRuntimeCommand(['update', '--preview'], deps)).status, 'preview');
  assert.equal((await runNativeRuntimeCommand(['update'], deps)).status, 'cancelled');
  assert.equal(mutations, 0);
});
test('CLI update --yes calls the lifecycle and installation delegates existing native setup', async () => {
  const calls = [];
  const deps = { platform: 'darwin', write: () => {}, resolvePaths: () => ({ dataDir: '/synthetic' }),
    plan: async () => ({}), manage: async input => { calls.push(input.action); return { status: 'updated' }; },
    setup: async args => { calls.push(args); return { status: 'ready' }; } };
  await runNativeRuntimeCommand(['update', '--yes'], deps);
  await runNativeRuntimeCommand(['install', '--yes'], deps);
  assert.equal(calls[0], 'update');
  assert.ok(calls[1].includes('--skip-agents'));
  assert.ok(calls[1].includes('native'));
});
