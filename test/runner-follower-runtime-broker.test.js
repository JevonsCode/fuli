import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { mock } from 'node:test';

import { holdPreparationLock } from '../src/runner/follower-local-runtime.js';
import { createFollowerBroker } from '../src/runner/follower-runtime-broker.js';
import { followerRuntimeHandlers } from '../src/runner/follower-runtime.js';
import { localProjectIds } from '../src/runner/owned-project-routes.js';
import { hostOwner, ROUTES_FILE, RoutesStore } from '../src/runner/routes-store.js';
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

function brokerFor(t, calls, owns = () => true) {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-broker-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const paths = resolveSetupPaths({ dataDir, env: {} });
  const controller = createFollowerBroker({ paths, url: 'http://127.0.0.1:32102', owns, read: () => ({ state: 'ready' }),
    createServices: () => ({ start: async () => calls.push('start'), stopProviders: async () => calls.push('sleep'),
      stopDatabases: async () => calls.push('stop') }),
    createBroker: () => ({ close: async () => calls.push('close') }) });
  return { dataDir, paths, controller };
}

test('a console restart leaves this computer’s Neo4j and Provider running; a stop ends them', async (t) => {
  const calls = [];
  const restarted = brokerFor(t, calls);
  await restarted.controller.current();
  writeFileSync(join(restarted.dataDir, 'runner', 'console-restarting'), new Date().toISOString());
  await restarted.controller.close();
  assert.deepEqual(calls, ['start', 'close']);
  calls.length = 0;
  const stopped = brokerFor(t, calls);
  await stopped.controller.current();
  await stopped.controller.close();
  assert.deepEqual(calls, ['start', 'close', 'stop']);
});

test('fuli restart on a follower replaces only its console, as the follower console, with the restart marked', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-broker-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  mkdirSync(join(dataDir, 'runner'), { recursive: true });
  const marker = join(dataDir, 'runner', 'console-restarting');
  let running = true;
  const spawned = [];
  const markedAtStop = [];
  const handlers = followerRuntimeHandlers({
    // The first answer is the stop's look at the console; it is gone after that until the start spawns one.
    fetchImpl: async () => {
      if (!spawned.length) markedAtStop.push(existsSync(marker));
      const answer = running ? { ok: true, json: async () => ({ kind: 'fuli-runner-console', dataDir, pid: 2 ** 30 }) } : { ok: false };
      if (!spawned.length) running = false;
      return answer;
    },
    spawnProcess: (_command, args) => { spawned.push(args.slice(1, 3)); running = true; return { unref() {} }; } });
  const paths = { dataDir };
  const result = await handlers.restart({ paths, port: 1 });
  assert.deepEqual(markedAtStop, [true, true], 'marked while the old console stops');
  assert.equal(result.status, 'started');
  assert.deepEqual(spawned, [['runner', 'console']]);
  assert.equal(existsSync(marker), false);
});

test('the projects routed here are read once per change of the routes file, and not at all without one', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-broker-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  assert.deepEqual(localProjectIds(dataDir), []);
  assert.equal(existsSync(join(dataDir, ROUTES_FILE)), false, 'asking makes no store');
  const routes = new RoutesStore(join(dataDir, ROUTES_FILE));
  routes.followEverything(hostOwner('a'.repeat(64)));
  routes.close();
  assert.deepEqual(localProjectIds(dataDir), []);
  const opened = mock.method(DatabaseSync.prototype, 'prepare');
  t.after(() => opened.mock.restore());
  assert.deepEqual(localProjectIds(dataDir), []);
  assert.equal(opened.mock.callCount(), 0, 'unchanged: the store is not read again');
  const again = new RoutesStore(join(dataDir, ROUTES_FILE));
  again.setLocalProject('project:sample', null);
  again.close();
  assert.deepEqual(localProjectIds(dataDir), ['sample']);
});
