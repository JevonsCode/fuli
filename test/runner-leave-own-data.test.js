import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { copyGraphBeforeRelease } from '../src/runner/follower-graph-aside.js';
import { RECORD_FILE } from '../src/runner/follower-local-runtime.js';
import { setAsideHostCopy } from '../src/runner/leave-global-copy.js';
import { OWNED_PROJECT_MARKER, recordOwnedProject } from '../src/runner/owned-project-routes.js';
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

test('a follower that only pins projects to its host leaves as before: the copy-only graph goes aside whole', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-leave-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const paths = resolveSetupPaths({ dataDir, env: {} });
  const routes = new RoutesStore(join(dataDir, ROUTES_FILE));
  routes.followEverything(hostOwner('a'.repeat(64)));
  // Written after the preparation's record, as `fuli routes` does: no data of this computer's own.
  routes.set('project:sample', hostOwner('a'.repeat(64)));
  routes.close();
  writeFileSync(join(dataDir, RECORD_FILE), JSON.stringify({ at: '2026-01-01T00:00:00.000Z' }));
  const calls = [];
  const fakes = { ownData: async (_paths, options) => { calls.push(['own', options.requireLive ?? false]); return null; },
    stop: async () => calls.push('stop'), copy: () => assert.fail('no full copy'), releaseScope: () => assert.fail('no release'),
    waitingRecruitments: () => assert.fail('no recruitments to count'),
    setAside: async () => { calls.push('aside'); return { folder: 'synthetic-aside' }; }, finish: released => calls.push(['finish', released]) };
  assert.equal(await setAsideHostCopy(paths, fakes), null, 'no copy arrived: nothing to set aside, nothing asked');
  assert.deepEqual(calls, [['finish', false]]);
  calls.length = 0;
  const again = new RoutesStore(join(dataDir, ROUTES_FILE));
  again.replicaArriving('global');
  again.close();
  assert.deepEqual(await setAsideHostCopy(paths, fakes), { folder: 'synthetic-aside' });
  assert.deepEqual(calls, [['own', false], 'stop', 'aside', ['finish', false]]);
  await assert.rejects(setAsideHostCopy(paths, { ...fakes, ownData: async () => '1 project(s)' }), { code: 'local_data_here' });
});

test('a leave tried again after its release failed reuses the whole copy it made, then clears its marks', async t => {
  const paths = machine(t);
  recordOwnedProject(paths.dataDir, 'project:sample');
  const calls = [];
  let release = { unreachable: true };
  const run = () => setAsideHostCopy(paths, { ownData: async () => '1 project', waitingRecruitments: async () => ({ count: 2 }),
    stop: async () => calls.push('stop'), restart: async () => calls.push('start'),
    copy: async (paths, at) => { calls.push('copy'); return copyGraphBeforeRelease(paths, at); },
    releaseScope: async () => { calls.push('release'); return release; } });
  await assert.rejects(run(), { code: 'release_unconfirmed' });
  assert.deepEqual(calls, ['stop', 'copy', 'start', 'release']);
  calls.length = 0;
  release = { released: true };
  const result = await run();
  assert.deepEqual(calls, ['release', 'stop'], 'the copy already made is whole: not made again');
  assert.equal(result.waitingRecruitments, 2);
  assert.equal(existsSync(join(paths.dataDir, OWNED_PROJECT_MARKER)), false);
  assert.equal(existsSync(join(paths.dataDir, 'runner', 'leave-copy.json')), false);
  assert.equal(readFileSync(join(result.folder, 'personal/project'), 'utf8'), 'synthetic project');
});

test('a copy that is no longer whole is made again', async t => {
  const paths = machine(t);
  const calls = [];
  let release = { unreachable: true };
  let made;
  let copies = 0;
  const run = () => setAsideHostCopy(paths, { ownData: async () => '1 project', waitingRecruitments: async () => ({ count: 0 }),
    stop: async () => calls.push('stop'), restart: async () => calls.push('start'),
    copy: async (paths, at) => { calls.push('copy'); made = await copyGraphBeforeRelease(paths, at + copies++); return made; },
    releaseScope: async () => { calls.push('release'); return release; } });
  await assert.rejects(run());
  writeFileSync(join(made.folder, 'personal/project'), 'cut');
  calls.length = 0;
  release = { released: true };
  await run();
  assert.deepEqual(calls, ['stop', 'copy', 'start', 'release', 'stop']);
});
