import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { createDeviceCertificate, deviceIdentity } from '../packages/roundtable/src/peer/device-identity.js';
import { startFollowerConsole, STATUS_PATH } from '../src/runner/follower-console.js';
import { graphHoldsNothingOfThePerson, localSpaceLine, prepareInBackground, readLocalRuntime, writeRecord }
  from '../src/runner/follower-local-runtime.js';
import { followerConsolePage } from '../src/runner/follower-page.js';
import { formatFollowerResult } from '../src/runner/follower-runtime.js';
import { prepareFollowerRuntime } from '../src/runner/follower-runtime-prepare.js';
import { followerLine, followerStatus } from '../src/runner/follower-status.js';
import { createHostConnection } from '../src/runner/host-connection.js';
import { startRunnerListener } from '../src/runner/host-listener.js';
import { createRunnerRoutes } from '../src/runner/host-routes.js';
import { FOLLOWER_GRAPH_FORMAT_HEADER, FOLLOWER_VERSION_HEADER, followerReport, hostSpaceFrom, hostSpaceReader }
  from '../src/runner/host-space.js';
import { RunnerHostStore } from '../src/runner/host-store.js';
import { localRouteRefusal } from '../src/runner/local-route-refusal.js';
import { RUNNER_FILE, RunnerStore } from '../src/runner/runner-store.js';
import { resolveSetupPaths } from '../src/setup/paths.js';
import { FULI_VERSION } from '../src/package-metadata.js';

// Nothing here starts a real process (runner-local-runtime.test.js): every step that would is a stand-in.
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  mock.method(childProcess, name, () => { throw new Error(`a test of this file started a real process (${name})`); });
}
syncBuiltinESMExports();

// docs/runner-roles-design.md §12, "A follower adopts the host's space ID". Synthetic computers only.
const HOST = { name: 'Host A', fingerprint: 'a'.repeat(64), certPem: 'synthetic', port: 2730, addresses: ['192.0.2.20'] };
const HOST_SPACE_ID = '0f0e0d0c-0b0a-4909-8807-060504030201';
const OWN_SPACE_ID = '11111111-2222-4333-8444-555555555555';
const KNOWN = Object.freeze({ known: true, spaceId: HOST_SPACE_ID, providerId: 'local-personal', graphFormat: 25,
  replicaProtocol: 1 });
const AWAY = Object.freeze({ known: false, reason: 'host_unreachable' });
const OLD_HOST = Object.freeze({ known: false, reason: 'host_too_old' });

function follower(t) {
  const dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'fuli-follower-space-')));
  t.after(() => rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 }));
  mkdirSync(path.join(dataDir, 'runner'), { recursive: true });
  const store = new RunnerStore(path.join(dataDir, RUNNER_FILE));
  store.saveHost(HOST);
  store.close();
  return dataDir;
}

// A graph an earlier preparation made: its instance directory with a database in it, and the settings naming it.
function madeGraph(dataDir, spaceId) {
  const paths = resolveSetupPaths({ dataDir, env: {} });
  mkdirSync(path.join(paths.nativePersonalDir, 'data', 'databases', 'neo4j'), { recursive: true });
  writeFileSync(path.join(paths.nativePersonalDir, 'data', 'databases', 'neo4j', 'store'), 'synthetic graph');
  writeFileSync(path.join(paths.nativePersonalDir, '.password-initialized'), '');
  writeFileSync(paths.graphRuntimeConfigPath, JSON.stringify({ version: 1, personal: { spaceId } }));
  return paths;
}

// The setup, the graph's answer, the health and the stop, each recorded instead of run.
function preparation({ host = KNOWN, projects = [], failEnsure = () => false } = {}) {
  const calls = [];
  return {
    calls,
    askHost: async () => { calls.push({ step: 'ask' }); return host; },
    free: async () => 50 * 1024 ** 3,
    keepPrivate: async () => true,
    ensure: async (input) => {
      calls.push({ step: 'ensure', input });
      if (failEnsure(input)) throw Object.assign(new Error('synthetic: the Provider refused'), { code: 'synthetic_failure' });
      if (input.graphSetup !== false && !existsSync(input.paths.graphRuntimeConfigPath)) {
        mkdirSync(input.paths.nativePersonalDir, { recursive: true });
        writeFileSync(path.join(input.paths.nativePersonalDir, 'fresh'), 'new graph');
        writeFileSync(input.paths.graphRuntimeConfigPath, JSON.stringify({ version: 1,
          personal: { spaceId: input.personalSpace?.id ?? OWN_SPACE_ID } }));
      }
    },
    health: async () => ({ globalReplica: true, replicaProtocol: 1, data_format: { supported_version: 25 } }),
    listProjects: async () => { calls.push({ step: 'list' }); return { projects }; },
    stop: async () => { calls.push({ step: 'stop' }); }
  };
}

const steps = (calls) => calls.map(({ step }) => step);

test('a host says its personal space and formats in hello; one without them is an earlier FULI', async (t) => {
  const [host, runner] = await Promise.all([createDeviceCertificate(), createDeviceCertificate()].map(async (made) => deviceIdentity(await made)));
  const hostStore = new RunnerHostStore(':memory:');
  hostStore.invite({ code: 'synthetic-invitation-code-0009', name: 'Runner B' });
  hostStore.pair({ code: 'synthetic-invitation-code-0009', fingerprint: runner.fingerprint, name: 'Runner B' });
  let healthAsked = 0;
  const app = { config: { personal: { spaceId: HOST_SPACE_ID } },
    personal: { health: async () => { healthAsked += 1;
      return { providerId: 'local-personal', replicaProtocol: 1, data_format: { supported_version: 25 } }; } } };
  const routes = createRunnerRoutes({ app, store: hostStore, hostName: 'Host A', hostFingerprint: host.fingerprint,
    withLease: (_owner, operation) => operation() });
  const earlier = createRunnerRoutes({ app: {}, store: hostStore, hostName: 'Host A', hostFingerprint: host.fingerprint,
    withLease: (_owner, operation) => operation() });
  let serving = routes;
  const heard = [];
  const listener = await startRunnerListener({ identity: host, addresses: ['127.0.0.1'], port: 0, sourceAllowed: () => true,
    route: (request, response, context) => {
      if (context.pathname.endsWith('/hello')) heard.push(request.headers);
      return serving.handle(request, response, context);
    } });
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'fuli-follower-hello-')));
  const store = new RunnerStore(path.join(dir, RUNNER_FILE));
  store.saveHost({ name: 'Host A', fingerprint: host.fingerprint, certPem: host.certPem, port: listener.port, addresses: ['127.0.0.1'] });
  const connection = createHostConnection({ store, identity: runner, lookUp: async () => [], bindAddresses: () => [],
    report: () => followerReport({ graph: 25, replicaProtocol: 1 }) });
  try {
    const greeting = await connection.hello();
    assert.deepEqual(greeting.space, { id: HOST_SPACE_ID, providerId: 'local-personal' });
    assert.deepEqual(greeting.formats, { graph: 25, replicaProtocol: 1 });
    assert.equal(greeting.version, FULI_VERSION, 'the FULI version, as before');
    assert.deepEqual(hostSpaceFrom(greeting), KNOWN);
    // The follower says its own versions with every hello.
    assert.equal(heard[0][FOLLOWER_VERSION_HEADER], FULI_VERSION);
    assert.equal(heard[0][FOLLOWER_GRAPH_FORMAT_HEADER], '25');
    await connection.hello();
    assert.equal(healthAsked, 1, 'the host asks its Provider once and keeps the answer');

    // An earlier host answers as it did: still paired and answering, without the space.
    serving = earlier;
    const old = await connection.hello();
    assert.equal(old.name, 'Host A');
    assert.equal(old.space, undefined);
    assert.deepEqual(hostSpaceFrom(old), OLD_HOST);
  } finally {
    connection.close();
    store.close();
    await listener.close();
    await routes.close();
    await earlier.close();
    hostStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the host leaves its space out while its Provider does not answer, and asks again at the next hello', async () => {
  let answers = false;
  const read = hostSpaceReader({ config: { personal: { spaceId: HOST_SPACE_ID } },
    personal: { health: async () => { if (!answers) throw new Error('synthetic: not answering'); return { providerId: 'local-personal' }; } } });
  assert.equal(await read(), null);
  answers = true;
  assert.deepEqual((await read()).space, { id: HOST_SPACE_ID, providerId: 'local-personal' });
  assert.deepEqual(hostSpaceFrom({ space: { id: 'not-a-space', providerId: 'x' } }), OLD_HOST, 'only a space ID is taken');
});

test('the graph is made under the host\'s personal space, with its Provider started as a follower\'s', { timeout: 60_000 }, async (t) => {
  const dataDir = follower(t);
  const prepared = preparation();
  const record = await prepareFollowerRuntime({ dataDir, env: {}, ...prepared });
  assert.deepEqual(steps(prepared.calls), ['ask', 'ensure', 'list', 'stop']);
  const { input } = prepared.calls[1];
  assert.deepEqual(input.personalSpace, { id: HOST_SPACE_ID, providerId: 'local-personal' });
  assert.equal(input.globalReplica, true, '`global` is the host\'s: no default record of it is written here');
  assert.equal(record.state, 'ready');
  assert.deepEqual(record.space, { state: 'same', id: HOST_SPACE_ID });
  assert.deepEqual(record.formats, { graph: 25, replicaProtocol: 1 }, 'sent with the next hello');
  const state = readLocalRuntime(dataDir);
  assert.equal(localSpaceLine(state).zh, '本机图谱：和主机是同一个空间。');
  assert.equal(prepareInBackground({ dataDir, spawnProcess: () => assert.fail('nothing left to do') }), false);
});

test('a Provider that did not start as a follower\'s is not taken for one', { timeout: 60_000 }, async (t) => {
  const dataDir = follower(t);
  const prepared = { ...preparation(), health: async () => ({ globalReplica: false }) };
  const record = await prepareFollowerRuntime({ dataDir, env: {}, ...prepared });
  assert.equal(record.state, 'failed');
  assert.equal(record.code, 'provider_not_follower');
});

test('with the host away the runtime is installed but no graph is made; the host\'s next answer makes it', { timeout: 60_000 }, async (t) => {
  const dataDir = follower(t);
  const away = preparation({ host: AWAY });
  const record = await prepareFollowerRuntime({ dataDir, env: {}, ...away });
  assert.deepEqual(steps(away.calls), ['ask', 'ensure', 'stop'], 'checked, then stopped; no graph to ask');
  assert.equal(away.calls[1].input.graphSetup, false);
  assert.equal(existsSync(path.join(dataDir, 'graph-runtime.json')), false, 'no space was made');
  assert.deepEqual(record.space, { state: 'later', reason: 'host_unreachable' });
  const state = readLocalRuntime(dataDir);
  assert.match(localSpaceLine(state).zh, /连上主机后建，用主机的空间；不用你做什么/);
  assert.equal(graphHoldsNothingOfThePerson(state), true);
  // The next start while the host is still away: asked again, nothing started.
  const stillAway = preparation({ host: AWAY });
  assert.equal((await prepareFollowerRuntime({ dataDir, env: {}, ...stillAway })).space.state, 'later');
  assert.deepEqual(steps(stillAway.calls), ['ask'], 'Neo4j is not started again for nothing');

  // The follower console: the host answers and says its space, so the preparation is started again by itself.
  const store = new RunnerStore(path.join(dataDir, RUNNER_FILE));
  const started = [];
  const answering = { connect: async () => ({ address: '192.0.2.20' }), current: { address: '192.0.2.20' }, pinFailed: false,
    hello: async () => ({ name: 'Host A', version: FULI_VERSION, space: { id: HOST_SPACE_ID, providerId: 'local-personal' },
      formats: { graph: 25, replicaProtocol: 1 } }), drop() {}, close() {}, postJson: async () => ({ reachable: true }) };
  let entry = null;
  try {
    entry = await startFollowerConsole({ dataDir, port: 0, store, connection: answering,
      prepare: (input) => { started.push(input); return true; } });
    await call(`${entry.url}${STATUS_PATH}`, { headers: { host: new URL(entry.url).host } });
    assert.deepEqual(started, [{ dataDir }]);
  } finally {
    await entry?.close();
    store.close();
  }
  const again = preparation();
  const made = await prepareFollowerRuntime({ dataDir, env: {}, ...again });
  assert.deepEqual(again.calls[1].input.personalSpace, { id: HOST_SPACE_ID, providerId: 'local-personal' });
  assert.deepEqual(made.space, { state: 'same', id: HOST_SPACE_ID });
});

test('an earlier FULI on the host is said as such, and nothing else changes', { timeout: 60_000 }, async (t) => {
  const dataDir = follower(t);
  const record = await prepareFollowerRuntime({ dataDir, env: {}, ...preparation({ host: OLD_HOST }) });
  assert.deepEqual(record.space, { state: 'later', reason: 'host_too_old' });
  const store = new RunnerStore(path.join(dataDir, RUNNER_FILE));
  try {
    const status = await followerStatus({ store, dataDir, connection: { hello: async () => ({ name: 'Host A', version: '0.28.0' }),
      current: { address: '192.0.2.20' }, pinFailed: false } });
    assert.equal(status.host.reachable, true, 'the host answers and is still followed');
    assert.equal(status.hostSpace.known, false);
    assert.equal(localSpaceLine(status.localRuntime).zh, '本机图谱：主机的 FULI 还不能给出空间信息，升级主机后继续；之后自动建好，不用你做什么。');
    assert.match(followerLine(status).zh, /本机图谱连上主机后建$/);
  } finally {
    store.close();
  }
});

test('an empty graph an earlier preparation made under its own space is set aside whole, not deleted, and made again', { timeout: 60_000 }, async (t) => {
  const dataDir = follower(t);
  const paths = madeGraph(dataDir, OWN_SPACE_ID);
  // What step 3a recorded: ready, made here, no project, no space said.
  writeRecord(dataDir, { state: 'ready', createdHere: true, projects: [], running: false, version: FULI_VERSION });
  assert.equal(readLocalRuntime(dataDir).space.state, 'later', 'made again once the host says its space');
  const prepared = preparation();
  const record = await prepareFollowerRuntime({ dataDir, env: {}, now: () => Date.parse('2026-11-24T08:00:00.000Z'), ...prepared });
  // Looked into again (started, asked, stopped) before anything moved; then made under the host's space.
  assert.deepEqual(steps(prepared.calls), ['ask', 'ensure', 'list', 'stop', 'ensure', 'list', 'stop']);
  assert.equal(prepared.calls[1].input.personalSpace, undefined, 'the earlier graph is started as it is, to look into it');
  assert.equal(prepared.calls[1].input.globalReplica, true, 'and writes nothing of `global` while it is looked into');
  assert.deepEqual(prepared.calls[4].input.personalSpace, { id: HOST_SPACE_ID, providerId: 'local-personal' });
  const folder = path.join(paths.nativeRuntimeDir, 'recovered', '2026-11-24T08-00-00-000Z');
  assert.deepEqual(record.space, { state: 'same', id: HOST_SPACE_ID, setAside: folder });
  // The whole instance directory and the settings naming it, moved as they were.
  assert.equal(readFileSync(path.join(folder, 'personal', 'data', 'databases', 'neo4j', 'store'), 'utf8'), 'synthetic graph');
  assert.ok(existsSync(path.join(folder, 'personal', '.password-initialized')));
  assert.equal(JSON.parse(readFileSync(path.join(folder, 'graph-runtime.json'), 'utf8')).personal.spaceId, OWN_SPACE_ID);
  assert.equal(JSON.parse(readFileSync(path.join(folder, 'follower-space.json'), 'utf8')).hostSpaceId, HOST_SPACE_ID);
  assert.deepEqual(readdirSync(paths.nativePersonalDir), ['fresh'], 'a new instance in its place');
  assert.equal(JSON.parse(readFileSync(paths.graphRuntimeConfigPath, 'utf8')).personal.spaceId, HOST_SPACE_ID);
  assert.match(localSpaceLine(readLocalRuntime(dataDir)).zh, /空图谱挪到了 .*recovered.*，没有删除/);
});

test('a graph with a project of the person\'s in it is left as it is, and says why no project can be this computer\'s', { timeout: 60_000 }, async (t) => {
  const dataDir = follower(t);
  const paths = madeGraph(dataDir, OWN_SPACE_ID);
  // Step 3a found none, but the look before anything moves finds one.
  writeRecord(dataDir, { state: 'ready', createdHere: true, projects: [], running: false, version: FULI_VERSION });
  const prepared = preparation({ projects: ['notes'] });
  const record = await prepareFollowerRuntime({ dataDir, env: {}, ...prepared });
  assert.deepEqual(steps(prepared.calls), ['ask', 'ensure', 'list', 'stop']);
  assert.deepEqual(record.space, { state: 'different' });
  assert.equal(existsSync(path.join(paths.nativeRuntimeDir, 'recovered')), false, 'nothing moved');
  assert.equal(JSON.parse(readFileSync(paths.graphRuntimeConfigPath, 'utf8')).personal.spaceId, OWN_SPACE_ID);
  const state = readLocalRuntime(dataDir);
  assert.equal(graphHoldsNothingOfThePerson(state), false);
  const line = localSpaceLine(state);
  assert.match(line.zh, /这台电脑有自己的 FULI 数据，空间和主机不同，所以现在不能在这台电脑上拥有本机项目/);
  assert.match(line.zh, /项目照常在主机上做/);
  assert.match(line.en, /cannot own a project here for now/);
  assert.doesNotMatch(`${line.zh}${line.en}`, /fuli |`/, 'no command to type');
  assert.equal(localRouteRefusal({ scope: 'project:new', localRuntime: state }).code, 'local_space_differs');
  assert.equal(prepareInBackground({ dataDir, spawnProcess: () => assert.fail('left as it is') }), false);
});

test('a graph that was here before any preparation is the person\'s: not started, and said as another space', { timeout: 60_000 }, async (t) => {
  const dataDir = follower(t);
  madeGraph(dataDir, OWN_SPACE_ID);
  const prepared = preparation();
  const record = await prepareFollowerRuntime({ dataDir, env: {}, ...prepared });
  assert.equal(record.state, 'existing');
  assert.deepEqual(prepared.calls, [], 'not even the host is asked: nothing would change');
  const state = readLocalRuntime(dataDir);
  assert.deepEqual(state.space, { state: 'different' });
  // The same three surfaces: the band's line, fuli status and the /local page.
  const status = { paired: true, host: { name: 'Host A', reachable: true, lastSeenAt: null, answeredAt: null },
    outbox: { queued: 0, entries: [], failedCount: 0 }, localRuntime: state, projects: [], capabilities: [] };
  assert.match(followerLine(status).zh, /本机有自己的数据（空间与主机不同）$/);
  assert.match(formatFollowerResult('status', { status: 'running', url: 'http://127.0.0.1:2727', ...status }),
    /This computer's graph: This computer has FULI data of its own/);
  assert.match(followerConsolePage({ status, hostPath: '/remote/host-a/' }), /data-space>本机图谱：这台电脑有自己的 FULI 数据/);
});

test('a remake that fails puts the earlier graph back, keeps what the attempt made beside it, and can be tried again', { timeout: 60_000 }, async (t) => {
  const dataDir = follower(t);
  const paths = madeGraph(dataDir, OWN_SPACE_ID);
  writeRecord(dataDir, { state: 'ready', createdHere: true, projects: [], running: false, version: FULI_VERSION });
  const prepared = preparation({ failEnsure: (input) => {
    if (!input.personalSpace) return false;
    // The attempt got as far as a new instance directory.
    mkdirSync(input.paths.nativePersonalDir, { recursive: true });
    writeFileSync(path.join(input.paths.nativePersonalDir, 'partial'), 'attempt');
    return true;
  } });
  const record = await prepareFollowerRuntime({ dataDir, env: {}, now: () => Date.parse('2026-11-24T09:00:00.000Z'), ...prepared });
  assert.equal(record.state, 'failed');
  assert.equal(record.code, 'synthetic_failure');
  assert.equal(readFileSync(path.join(paths.nativePersonalDir, 'data', 'databases', 'neo4j', 'store'), 'utf8'), 'synthetic graph');
  assert.equal(JSON.parse(readFileSync(paths.graphRuntimeConfigPath, 'utf8')).personal.spaceId, OWN_SPACE_ID);
  const folder = path.join(paths.nativeRuntimeDir, 'recovered', '2026-11-24T09-00-00-000Z');
  assert.equal(readFileSync(path.join(folder, 'attempt', 'personal', 'partial'), 'utf8'), 'attempt', 'kept, not deleted');
  assert.equal(steps(prepared.calls).at(-1), 'stop', 'what the attempt started is stopped');
  // 「重新准备」 tries it again.
  const again = preparation();
  const made = await prepareFollowerRuntime({ dataDir, env: {}, now: () => Date.parse('2026-11-24T10:00:00.000Z'), ...again });
  assert.equal(made.space.state, 'same');
});

function call(url, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, text }));
    });
    request.on('error', reject);
    request.end();
  });
}
