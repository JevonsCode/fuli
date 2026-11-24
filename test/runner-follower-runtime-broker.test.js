import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { holdPreparationLock } from '../src/runner/follower-local-runtime.js';
import { createFollowerBroker } from '../src/runner/follower-runtime-broker.js';
import { resolveSetupPaths } from '../src/setup/paths.js';

test('a follower begins managing its graph only after it owns a project, under the import lock', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-broker-'));
  const paths = resolveSetupPaths({ dataDir, env: {} });
  const url = 'http://127.0.0.1:32101';
  let owns = false;
  const calls = [];
  let services;
  const controller = createFollowerBroker({ paths, url, owns: () => owns,
    read: () => ({ state: 'ready' }), createServices(input) {
      assert.equal(input.personalOnly, true);
      assert.equal(input.globalReplica, undefined, 'the native start resolves the current route itself');
      return { start: async () => calls.push('start'), stopProviders: async () => calls.push('sleep'),
        stopDatabases: async () => calls.push('stop') };
    }, createBroker(input) { services = input.services; return { close: async () => calls.push('close') }; } });
  t.after(async () => { await controller.close(); rmSync(dataDir, { recursive: true, force: true }); });
  assert.equal(await controller.current(), null);
  assert.deepEqual(calls, []);
  owns = true;
  assert.ok(await controller.current());
  assert.deepEqual(calls, ['start']);
  assert.equal(JSON.parse(readFileSync(paths.graphRuntimeStatePath)).url, url);
  const release = holdPreparationLock(dataDir);
  try {
    await assert.rejects(services.stopProviders(), /synced/);
    await assert.rejects(services.start(), /synced/);
    assert.deepEqual(calls, ['start']);
  } finally { release(); }
  await services.stopProviders();
  assert.deepEqual(calls, ['start', 'sleep']);
});
