import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { copyGraphBeforeRelease } from '../src/runner/follower-graph-aside.js';
import { setAsideHostCopy } from '../src/runner/leave-global-copy.js';
import { recordOwnedProject } from '../src/runner/owned-project-routes.js';
import { hostOwner, RoutesStore, ROUTES_FILE } from '../src/runner/routes-store.js';
import { resolveSetupPaths } from '../src/setup/paths.js';

function machine(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-leave-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const paths = resolveSetupPaths({ dataDir, env: {} });
  mkdirSync(paths.nativePersonalDir, { recursive: true });
  writeFileSync(join(paths.nativePersonalDir, 'project'), 'synthetic project');
  writeFileSync(paths.graphRuntimeConfigPath, JSON.stringify({ personal: { spaceId: 'sample' } }));
  const routes = new RoutesStore(join(dataDir, ROUTES_FILE));
  routes.followEverything(hostOwner('a'.repeat(64)));
  routes.setLocalProject('project:sample', null);
  routes.replicaArriving('global');
  routes.close();
  return paths;
}

test('leave preserves a complete offline copy and releases only the pinned owner, even on a retry', async t => {
  const paths = machine(t);
  const calls = [];
  let backup;
  const result = await setAsideHostCopy(paths, { ownData: async () => '1 project',
    stop: async () => calls.push('stop'), restart: async () => calls.push('start'),
    copy: async (paths, at) => { calls.push('copy'); backup = await copyGraphBeforeRelease(paths, at); return backup; },
    releaseScope: async (_config, owner) => { assert.equal(owner, 'a'.repeat(64)); calls.push('release');
      assert.equal(readFileSync(join(backup.folder, 'personal/project'), 'utf8'), 'synthetic project');
      return { refused: 409, code: 'replica_not_held' }; }, setAside: () => assert.fail('never move local projects') });
  assert.deepEqual(calls, ['stop', 'copy', 'start', 'release', 'stop']);
  assert.equal(readFileSync(join(paths.nativePersonalDir, 'project'), 'utf8'), 'synthetic project');
  assert.equal(result.released, true);
});

test('unknown live data after an earlier local route and insufficient disk space preserve the graph', async t => {
  const paths = machine(t);
  recordOwnedProject(paths.dataDir, 'project:sample');
  const routes = new RoutesStore(join(paths.dataDir, ROUTES_FILE));
  routes.set('project:sample', hostOwner('a'.repeat(64)));
  routes.close();
  await assert.rejects(setAsideHostCopy(paths, { stop: () => assert.fail('nothing stopped') }), { code: 'own_data_unknown' });
  await assert.rejects(copyGraphBeforeRelease(paths, Date.now(), { free: async () => 0 }), { code: 'disk_low' });
  assert.equal(readFileSync(join(paths.nativePersonalDir, 'project'), 'utf8'), 'synthetic project');
});
