import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { FULI_VERSION } from '../src/package-metadata.js';
import { openRoutes } from '../src/runner/call-routes.js';
import { copyCatchUp, PREPARE_RETRY_MS, prepareInBackground, readRecord, writeRecord }
  from '../src/runner/follower-local-runtime.js';
import { prepareFollowerRuntime } from '../src/runner/follower-runtime-prepare.js';
import { globalCopyLine, readGlobalCopyRecord, recordGlobalCopy } from '../src/runner/global-copy-state.js';
import { copyWorthStarting, startGlobalSync } from '../src/runner/global-sync.js';
import { GLOBAL_SCOPE } from '../src/runner/routes-store.js';
import { RUNNER_FILE, RunnerStore } from '../src/runner/runner-store.js';
import { resolveSetupPaths } from '../src/setup/paths.js';

// Nothing here starts a real process: every step that would is a stand-in.
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  mock.method(childProcess, name, () => { throw new Error(`a test of this file started a real process (${name})`); });
}
syncBuiltinESMExports();

// docs/runner-roles-design.md §12 "The sync loop": a runtime prepared under the host's space
// that still owes the copy of the host's global. Synthetic computers and records only.
const HOST = { name: 'Host A', fingerprint: 'a'.repeat(64), certPem: 'synthetic', port: 2730, addresses: ['192.0.2.20'] };
const HOST_SPACE_ID = '0f0e0d0c-0b0a-4909-8807-060504030201';
const FORMATS = Object.freeze({ graph: 25, replicaProtocol: 1 });
const GREETING = Object.freeze({ space: { id: HOST_SPACE_ID, providerId: 'local-personal' }, formats: FORMATS });
const DIGEST = 'd'.repeat(64);

// A follower whose runtime an earlier version prepared under the host's space.
function preparedFollower(t, { version = FULI_VERSION } = {}) {
  const dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'fuli-copy-catch-up-')));
  t.after(() => rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 }));
  mkdirSync(path.join(dataDir, 'runner'), { recursive: true });
  const store = new RunnerStore(path.join(dataDir, RUNNER_FILE));
  store.saveHost(HOST);
  store.close();
  const paths = resolveSetupPaths({ dataDir, env: {} });
  mkdirSync(paths.nativePersonalDir, { recursive: true });
  writeFileSync(path.join(paths.nativePersonalDir, 'store'), 'synthetic graph');
  writeFileSync(paths.graphRuntimeConfigPath, JSON.stringify({ version: 1, personal: { spaceId: HOST_SPACE_ID } }));
  writeRecord(dataDir, { state: 'ready', at: '2026-11-20T08:00:00.000Z', version, createdHere: true, running: false,
    projects: [], formats: FORMATS, space: { state: 'same', id: HOST_SPACE_ID } });
  openRoutes(dataDir).close();
  return dataDir;
}

// What a copy that arrived leaves behind (global-sync.js).
function copyArrived(dataDir, digest = DIGEST) {
  const routes = openRoutes(dataDir);
  try { routes.replicaSynced(GLOBAL_SCOPE, '2026-11-20T08:05:00.000Z'); } finally { routes.close(); }
  recordGlobalCopy(dataDir, { digest, checkedAt: '2026-11-20T08:05:00.000Z', last: { at: '2026-11-20T08:05:00.000Z', outcome: 'synced', digest } });
}

// The host as the preparation reaches it on its own connection: hello and the digest, recorded.
function hostAnswering({ greeting = GREETING, digest = DIGEST } = {}) {
  const asked = [];
  const connection = {
    hello: async () => { asked.push('hello'); return greeting; },
    getText: async (pathName) => {
      const part = new URL(pathName, 'https://x.invalid').searchParams.get('part');
      asked.push(part);
      return { reachable: true, status: 200, text: JSON.stringify({ scope: 'global', spaceId: HOST_SPACE_ID, digest,
        complete: true, ...{ graphFormat: 25, replicaProtocol: 1 }, bytes: 10 }) };
    }
  };
  const withHost = async (_dataDir, _options, use) => use({ store: { host: () => HOST }, connection });
  return { asked, worthStarting: (input) => copyWorthStarting({ ...input, withHost }) };
}

// The setup, the graph's answers, the health and the stop, recorded instead of run; the first sync lands a copy.
function preparation(host, { health = () => ({ globalReplica: true, replicaProtocol: 1, data_format: { supported_version: 25, state: 'current' } }),
  ownGlobal = 0 } = {}) {
  const calls = [];
  return {
    calls,
    worthStarting: host.worthStarting,
    askHost: async () => { calls.push({ step: 'ask' }); return { known: false, reason: 'host_unreachable' }; },
    free: async () => 50 * 1024 ** 3,
    keepPrivate: async () => true,
    ensure: async (input) => {
      calls.push({ step: 'ensure', input });
      if (!existsSync(input.paths.graphRuntimeConfigPath)) {
        mkdirSync(input.paths.nativePersonalDir, { recursive: true });
        writeFileSync(input.paths.graphRuntimeConfigPath, JSON.stringify({ version: 1, personal: { spaceId: input.personalSpace?.id } }));
      }
    },
    health: async () => health(),
    listProjects: async () => { calls.push({ step: 'list' }); return { projects: [] }; },
    countOwnGlobal: async () => ({ count: ownGlobal, labels: {} }),
    stop: async () => { calls.push({ step: 'stop' }); },
    setAside: async (paths, at, note) => {
      calls.push({ step: 'aside', note });
      const folder = path.join(paths.nativeRuntimeDir, 'recovered', 'synthetic');
      mkdirSync(folder, { recursive: true });
      rmSync(paths.graphRuntimeConfigPath, { force: true });
      return { folder, restore: async () => {} };
    },
    firstSync: async ({ dataDir }) => { calls.push({ step: 'sync' }); copyArrived(dataDir); return { outcome: 'synced' }; }
  };
}
const steps = (calls) => calls.map(({ step }) => step);

test('a follower prepared before copies existed gets its first copy at the console\'s start while the host answers', async (t) => {
  const dataDir = preparedFollower(t);
  assert.equal(copyCatchUp(dataDir), 'first');
  const spawned = [];
  assert.equal(prepareInBackground({ dataDir, spawnProcess: (...args) => { spawned.push(args); return { unref() {} }; } }), true);
  rmSync(path.join(dataDir, 'runner', 'local-runtime.claim'), { force: true });
  const host = hostAnswering();
  const prepared = preparation(host);
  const record = await prepareFollowerRuntime({ dataDir, env: {}, ...prepared });
  assert.deepEqual(steps(prepared.calls), ['ensure', 'list', 'sync', 'stop'], 'started once, synced, stopped again');
  assert.deepEqual(host.asked, ['hello', 'digest'], 'only the hello and the digest before anything started');
  assert.equal(prepared.calls[0].input.globalReplica, true);
  assert.equal(record.state, 'ready');
  assert.equal(copyCatchUp(dataDir), null, 'nothing owed once the copy is in');
  assert.equal(prepareInBackground({ dataDir, spawnProcess: () => assert.fail('nothing left to do') }), false);
});

test('with the host away nothing is started, the record stays as it was, and the state says why', async (t) => {
  const dataDir = preparedFollower(t);
  const before = readRecord(dataDir);
  const prepared = preparation(hostAnswering({ greeting: null }));
  await prepareFollowerRuntime({ dataDir, env: {}, ...prepared });
  assert.deepEqual(steps(prepared.calls), [], 'no Neo4j for a host that does not answer');
  assert.deepEqual(readRecord(dataDir), before);
  assert.equal(readGlobalCopyRecord(dataDir).last.reason, 'host_unreachable');
  const line = globalCopyLine({ last: readGlobalCopyRecord(dataDir).last, running: false });
  assert.match(line.zh, /还没同步过。上次同步时主机不在线，连上后再同步。.*控制台启动、且主机在线时补上第一份/);
});

test('the same refusal in the same situation starts nothing; a changed digest starts once', async (t) => {
  const dataDir = preparedFollower(t);
  recordGlobalCopy(dataDir, { last: { at: '2026-11-20T08:05:00.000Z', outcome: 'refused', by: 'here', code: 'replica_owner_changed',
    digest: DIGEST, host: FORMATS, own: FORMATS, spaceId: HOST_SPACE_ID } });
  const same = preparation(hostAnswering());
  await prepareFollowerRuntime({ dataDir, env: {}, ...same });
  assert.deepEqual(steps(same.calls), [], 'the same refusal again would start Neo4j for nothing');
  assert.equal(copyCatchUp(dataDir), 'first', 'still owed, and said as refused');

  const changed = preparation(hostAnswering({ digest: 'c'.repeat(64) }));
  await prepareFollowerRuntime({ dataDir, env: {}, ...changed });
  assert.deepEqual(steps(changed.calls), ['ensure', 'list', 'sync', 'stop']);
});

test('versions that differ start nothing either', async (t) => {
  const dataDir = preparedFollower(t);
  const prepared = preparation(hostAnswering({ greeting: { ...GREETING, formats: { graph: 26, replicaProtocol: 1 } } }));
  await prepareFollowerRuntime({ dataDir, env: {}, ...prepared });
  assert.deepEqual(steps(prepared.calls), []);
  assert.equal(readGlobalCopyRecord(dataDir).last.outcome, 'versions_differ');
});

test('a FULI update starts the runtime once to bring its format and the copy up to date; an unchanged one starts nothing', async (t) => {
  const dataDir = preparedFollower(t, { version: '0.0.1' });
  copyArrived(dataDir);
  assert.equal(copyCatchUp(dataDir), 'upgrade');
  const prepared = preparation(hostAnswering());
  const record = await prepareFollowerRuntime({ dataDir, env: {}, ...prepared });
  assert.deepEqual(steps(prepared.calls), ['ensure', 'list', 'sync', 'stop']);
  assert.equal(record.version, FULI_VERSION);
  assert.equal(copyCatchUp(dataDir), null);
  const again = preparation(hostAnswering());
  await prepareFollowerRuntime({ dataDir, env: {}, ...again });
  assert.deepEqual(steps(again.calls), [], 'synced and the same version: nothing started');
});

test('a graph whose format waits for a person\'s step and holds only the copy is set aside and made again', async (t) => {
  const dataDir = preparedFollower(t, { version: '0.0.1' });
  copyArrived(dataDir);
  let asked = 0;
  const health = () => ({ globalReplica: true, replicaProtocol: 1,
    data_format: { supported_version: 25, state: (asked += 1) === 1 ? 'pending_confirmation' : 'current' } });
  const prepared = preparation(hostAnswering(), { health });
  const record = await prepareFollowerRuntime({ dataDir, env: {}, ...prepared });
  assert.deepEqual(steps(prepared.calls), ['ensure', 'list', 'stop', 'aside', 'ensure', 'list', 'sync', 'stop']);
  assert.equal(prepared.calls[3].note.kind, 'follower-format-behind');
  assert.deepEqual(prepared.calls[4].input.personalSpace, { id: HOST_SPACE_ID, providerId: 'local-personal' });
  assert.equal(record.state, 'ready');
  assert.deepEqual(record.space, { state: 'same', id: HOST_SPACE_ID }, 'not said as the empty graph of a space of its own');
});

test('a graph whose format waits and holds the person\'s data is left as it is and said so', async (t) => {
  const dataDir = preparedFollower(t, { version: '0.0.1' });
  copyArrived(dataDir);
  const health = () => ({ globalReplica: true, replicaProtocol: 1, data_format: { supported_version: 25, state: 'pending_confirmation' } });
  const prepared = preparation(hostAnswering(), { health, ownGlobal: 2 });
  const record = await prepareFollowerRuntime({ dataDir, env: {}, ...prepared });
  assert.deepEqual(steps(prepared.calls), ['ensure', 'list', 'stop']);
  assert.equal(record.state, 'failed');
  assert.equal(record.code, 'graph_format_waits');
  assert.match(record.message, /fuli runner leave/);
});

test('a running console starts the owed preparation again only once the host answers, and backs off', async (t) => {
  const dataDir = preparedFollower(t);
  let clock = 0;
  let reachable = false;
  let prepared = 0;
  const store = new RunnerStore(path.join(dataDir, RUNNER_FILE));
  const connection = { current: null, connect: async () => (reachable ? {} : null), hello: async () => assert.fail('no sync without a runtime') };
  const loop = startGlobalSync({ dataDir, store, connection, tick: 3_600_000, now: () => clock, providerRecorded: () => false,
    health: async () => assert.fail('a Provider the process record does not name is not asked'),
    prepare: () => { prepared += 1; return true; } });
  try {
    assert.equal(await loop.round(), null, 'the console\'s own start just started one');
    clock = PREPARE_RETRY_MS;
    assert.equal(await loop.round(), null, 'the host does not answer: nothing started');
    clock += PREPARE_RETRY_MS;
    reachable = true;
    assert.equal(await loop.round(), null, 'twice as long after a try');
    clock = PREPARE_RETRY_MS * 3;
    assert.deepEqual(await loop.round(), { outcome: 'preparing', reason: 'copy_owed' });
    assert.equal(prepared, 1);
    clock += PREPARE_RETRY_MS * 3;
    assert.equal(await loop.round(), null);
    assert.equal(prepared, 1, 'not every minute');
    clock += PREPARE_RETRY_MS;
    await loop.round();
    assert.equal(prepared, 2);
    copyArrived(dataDir);
    clock += PREPARE_RETRY_MS * 100;
    assert.equal(await loop.round(), null, 'nothing owed any more');
    assert.equal(prepared, 2);
  } finally {
    loop.close();
    store.close();
  }
});
