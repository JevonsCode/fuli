import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runLocalRuntimeCommand } from '../src/cli/local-runtime-command.js';
import { runSetupCommand } from '../src/cli/setup-command.js';
import { openRoutes } from '../src/runner/call-routes.js';
import { startFollowerConsole, STATUS_PATH, whoAnswers } from '../src/runner/follower-console.js';
import { CLAIM_TTL_MS, graphHoldsNothingOfThePerson, holdPreparationLock, localRuntimeLine, localRuntimeShort,
  prepareInBackground, readLocalRuntime, RECORD_FILE, writeRecord } from '../src/runner/follower-local-runtime.js';
import { FULI_VERSION } from '../src/package-metadata.js';
import { DEFAULT_PERSONAL_SPACE_NAME } from '../src/setup/options.js';
import { followerConsolePage, PREPARE_PATH } from '../src/runner/follower-page.js';
import { formatFollowerResult } from '../src/runner/follower-runtime.js';
import { LEAST_FREE_BYTES, prepareFollowerRuntime } from '../src/runner/follower-runtime-prepare.js';
import { followerStatus } from '../src/runner/follower-status.js';
import { joinHost } from '../src/runner/join.js';
import { hostOwner } from '../src/runner/routes-store.js';
import { RUNNER_FILE, RunnerStore } from '../src/runner/runner-store.js';
import { recoverBlockedPorts } from '../src/system/blocked-port-recovery.js';

// docs/runner-roles-design.md §10, §11 step 3a: a follower's own runtime, prepared in the background,
// stopped again while no scope is its own, said as it is everywhere. Synthetic computers only.
const HOST = { name: 'Host A', fingerprint: 'a'.repeat(64), certPem: 'synthetic', port: 2730, addresses: ['192.0.2.20'] };
const NOWHERE = Object.freeze({ connect: async () => null, hello: async () => null, drop() {}, close() {},
  postJson: async () => ({ reachable: false }), current: null, pinFailed: false });

function follower(t) {
  const dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'fuli-own-runtime-')));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  mkdirSync(path.join(dataDir, 'runner'), { recursive: true });
  const store = new RunnerStore(path.join(dataDir, RUNNER_FILE));
  store.saveHost(HOST);
  store.close();
  return dataDir;
}

// The setup a first start does, the graph's own answer and the stop, each recorded instead of run.
function preparation({ free = 50 * 1024 ** 3, fail = null, projects = [] } = {}) {
  const calls = [];
  return {
    calls,
    free: async () => free,
    keepPrivate: async (dataDir) => { calls.push({ step: 'private', dataDir }); return true; },
    ensure: async (input, dependencies) => {
      calls.push({ step: 'ensure', input, dependencies });
      if (fail) throw Object.assign(new Error('synthetic: Neo4j did not start'), { code: fail });
      writeFileSync(input.paths.graphRuntimeConfigPath, '{"synthetic":true}');
    },
    listProjects: async () => { calls.push({ step: 'list' }); return { projects }; },
    stop: async (_paths, _env, options) => { calls.push({ step: 'stop', options }); }
  };
}

test('the preparation sets up the personal graph without a console, checks it, and stops it while no scope is local', async (t) => {
  const dataDir = follower(t);
  const steps = preparation();
  const record = await prepareFollowerRuntime({ dataDir, env: {}, ...steps });
  assert.equal(record.state, 'ready');
  const [keptPrivate, ensure, list, stop] = steps.calls;
  assert.deepEqual([keptPrivate.step, ensure.step, list.step, stop.step], ['private', 'ensure', 'list', 'stop']);
  assert.equal(keptPrivate.dataDir, dataDir, 'the data directory is kept private before the graph is written, as setup does');
  // The Provider refuses an empty space name (422 at /v1/bootstrap): the graph is made as setup makes it.
  assert.equal(ensure.input.personalSpaceName, DEFAULT_PERSONAL_SPACE_NAME);
  assert.ok(ensure.input.personalSpaceName.length > 0);
  assert.equal(ensure.input.noStart, true, 'no second console: the follower console is the one listener on its port');
  assert.equal(ensure.input.personalOnly, true);
  assert.equal(ensure.input.runtimeMode, 'native');
  assert.equal(stop.options.runtimeMode, 'native');
  // The console port is the follower console's own: kept, never moved away from or taken for another FULI.
  const settings = { lanAccess: false, ports: { console: 2727 } };
  const kept = await ensure.dependencies.recoverPorts(settings, { fuliConsoleAt: async () => true,
    readRanges: () => [], probe: async () => 'EADDRINUSE' });
  assert.deepEqual(kept.moves, []);
  await assert.rejects(recoverBlockedPorts(settings, { fuliConsoleAt: async () => true, readRanges: () => [],
    probe: async () => 'EADDRINUSE' }), /Another FULI/, 'what an ordinary start would have said');

  const state = readLocalRuntime(dataDir);
  assert.equal(state.state, 'ready');
  assert.equal(state.running, false);
  assert.equal(state.createdHere, true, 'there was no graph here before');
  assert.equal(graphHoldsNothingOfThePerson(state), true);
  assert.equal(localRuntimeLine(state).zh, '本机运行时：已准备好，未运行（还没有本机项目）。');
  assert.match(localRuntimeLine(state).en, /prepared, not running \(no project is this computer's yet\)/);
  const routes = openRoutes(dataDir);
  assert.ok(routes.all().every((row) => row.owner !== 'local'), 'no route was written: nothing goes to it yet');
  assert.equal(routes.owner('project:anything'), hostOwner(HOST.fingerprint));
  routes.close();
});

test('too little free disk downloads nothing, and says how much is missing', async (t) => {
  const dataDir = follower(t);
  const steps = preparation({ free: 1024 ** 3 });
  const record = await prepareFollowerRuntime({ dataDir, env: {}, ...steps });
  assert.equal(record.state, 'failed');
  assert.deepEqual(steps.calls, [], 'nothing was set up or started');
  const state = readLocalRuntime(dataDir);
  assert.equal(state.code, 'disk_low');
  assert.equal(state.needBytes, LEAST_FREE_BYTES);
  assert.match(localRuntimeLine(state).zh, /磁盘只剩 1\.0 GB，需要 3\.0 GB。转发到主机的调用不受影响/);
});

test('a preparation that fails stops what it started and is said as failed, not as the host being away', async (t) => {
  const dataDir = follower(t);
  const steps = preparation({ fail: 'neo4j_start_failed' });
  await prepareFollowerRuntime({ dataDir, env: {}, ...steps });
  assert.deepEqual(steps.calls.map((call) => call.step), ['private', 'ensure', 'stop']);
  const state = readLocalRuntime(dataDir);
  assert.equal(state.state, 'failed');
  assert.equal(state.code, 'neo4j_start_failed');
  assert.match(localRuntimeLine(state).en, /did not succeed \(neo4j_start_failed\)\. It is not tried again by itself/);
  assert.match(localRuntimeLine(state).zh, /不会自动再试.*按「重新准备」/);
  assert.equal(localRuntimeShort(state).en, 'own runtime preparation failed');
  // Tried again: the graph a failed attempt made is still this computer's own making.
  const again = preparation();
  await prepareFollowerRuntime({ dataDir, env: {}, ...again });
  assert.equal(readLocalRuntime(dataDir).createdHere, true);
});

test('one preparation at a time, held by the OS lock rather than a PID; one cut short is said as interrupted', async (t) => {
  const dataDir = follower(t);
  writeRecord(dataDir, { state: 'preparing', pid: 4242, startedAt: '2026-11-24T08:00:00.000Z', createdHere: true });
  const holder = holdPreparationLock(dataDir);
  const steps = preparation();
  const busy = await prepareFollowerRuntime({ dataDir, env: {}, lock: (dir) => holdPreparationLock(dir, { waitMs: 0 }), ...steps });
  assert.equal(busy.state, 'preparing');
  assert.deepEqual(steps.calls, []);
  assert.equal(readLocalRuntime(dataDir).state, 'preparing', 'the lock is held: under way');
  holder();
  // The same PID may be any program now: what counts is that nobody holds the lock.
  const cut = readLocalRuntime(dataDir);
  assert.equal(cut.state, 'failed');
  assert.equal(cut.code, 'interrupted');
});

test('two starts at almost the same moment spawn one preparation', (t) => {
  const dataDir = follower(t);
  const spawned = [];
  const spawnProcess = (command, args, options) => { spawned.push({ args, options }); return { unref() {} }; };
  // Neither spawned process has started yet (no record, no lock): only the claim keeps the second out.
  assert.equal(prepareInBackground({ dataDir, spawnProcess }), true);
  assert.equal(prepareInBackground({ dataDir, spawnProcess }), false);
  assert.equal(spawned.length, 1);
  assert.equal(readLocalRuntime(dataDir).state, 'preparing', 'said as already being prepared');
  // A claim nobody took over (the process never started) does not hold forever.
  const later = () => Date.now() + CLAIM_TTL_MS + 1000;
  assert.equal(readLocalRuntime(dataDir, { now: later }).state, 'not_prepared');
  assert.equal(prepareInBackground({ dataDir, spawnProcess, now: later }), true);
  assert.equal(spawned.length, 2);
});

test('a preparation spawned after another one finished does nothing again', async (t) => {
  const dataDir = follower(t);
  writeRecord(dataDir, { state: 'ready', createdHere: true, projects: [], version: FULI_VERSION });
  const steps = preparation();
  const record = await prepareFollowerRuntime({ dataDir, env: {}, ...steps });
  assert.equal(record.state, 'ready');
  assert.deepEqual(steps.calls, [], 'nothing installed, started or stopped');
});

test('a graph that was here before the preparation is not started, upgraded or changed', async (t) => {
  const dataDir = follower(t);
  writeFileSync(path.join(dataDir, 'graph-runtime.json'), '{"synthetic":"own"}');
  const steps = preparation();
  const record = await prepareFollowerRuntime({ dataDir, env: {}, ...steps });
  assert.equal(record.state, 'existing');
  assert.deepEqual(steps.calls, [], 'not started (no identity upgrade, no format step), not stopped, nothing written');
  assert.equal(readFileSync(path.join(dataDir, 'graph-runtime.json'), 'utf8'), '{"synthetic":"own"}');
  const state = readLocalRuntime(dataDir);
  assert.equal(state.state, 'existing');
  assert.equal(graphHoldsNothingOfThePerson(state), false);
  assert.match(localRuntimeLine(state).zh, /本机已有图谱，这一步没有动它/);
  assert.match(localRuntimeLine(state).en, /already has a graph of its own; this step left it alone/);
  assert.equal(prepareInBackground({ dataDir, spawnProcess: () => assert.fail('not prepared again') }), false);
});

test('the background preparation starts only when it is not done and not under way, and retries only what can pass', (t) => {
  const dataDir = follower(t);
  const spawned = [];
  const spawnProcess = (command, args, options) => { spawned.push({ args, options }); return { unref() {} }; };
  // What the spawned process does first once it holds the lock.
  const takenOver = () => rmSync(path.join(dataDir, 'runner', 'local-runtime.claim'), { force: true });
  assert.equal(prepareInBackground({ dataDir, spawnProcess }), true);
  assert.deepEqual(spawned[0].args.slice(1), ['runner', 'prepare-local', '--data-dir', dataDir]);
  assert.equal(spawned[0].options.detached, true);
  takenOver();
  writeRecord(dataDir, { state: 'preparing', pid: 4242, createdHere: true });
  assert.equal(prepareInBackground({ dataDir, spawnProcess, underWay: () => true }), false);
  writeRecord(dataDir, { state: 'ready', createdHere: true, projects: [] });
  assert.equal(prepareInBackground({ dataDir, spawnProcess }), false);
  const failed = (record) => writeRecord(dataDir, { state: 'failed', createdHere: true, version: FULI_VERSION, ...record });
  failed({ code: 'disk_low' });
  assert.equal(prepareInBackground({ dataDir, spawnProcess }), true, 'too little disk is tried again at the next start');
  takenOver();
  writeRecord(dataDir, { state: 'preparing', pid: 4242, createdHere: true });
  assert.equal(prepareInBackground({ dataDir, spawnProcess, underWay: () => false }), true, 'an interrupted one is tried again');
  assert.equal(readLocalRuntime(dataDir, { underWay: () => false }).state, 'preparing', 'the new one, not the one cut short');
  takenOver();
  failed({ code: 'neo4j_start_failed', version: '0.0.1' });
  assert.equal(prepareInBackground({ dataDir, spawnProcess }), true, 'another FULI version tries again');
  takenOver();
  failed({ code: 'neo4j_start_failed' });
  const before = spawned.length;
  assert.equal(prepareInBackground({ dataDir, spawnProcess }), false, 'the same failure waits for 「重新准备」');
  assert.equal(spawned.length, before);
  assert.equal(prepareInBackground({ dataDir, spawnProcess, again: true }), true, '「重新准备」 tries any failure again');
});

test('fuli setup on a follower starts the preparation in the background and says so', async (t) => {
  const dataDir = follower(t);
  const written = [];
  let asked = 0;
  const result = await runSetupCommand(['--data-dir', dataDir, '--yes'], { write: (line) => written.push(line),
    setupRunnerClients: async () => [], prepareLocalRuntime: () => { asked += 1; return true; },
    planSetup: () => assert.fail('a follower plans no console of its own') });
  assert.equal(result.status, 'runner');
  assert.equal(asked, 1);
  assert.match(written.join('\n'), /being prepared in the background; calls keep going to the host/);
});

// Who answers a path of the follower's console: decided in one place (step 3c adds scopes there).
test('the follower console answers its own paths and carries every other one to the host', () => {
  for (const own of [STATUS_PATH, PREPARE_PATH, '/local']) assert.equal(whoAnswers(own), 'local', own);
  for (const host of ['/', '/api/personal-projects', '/projects/widgets']) assert.equal(whoAnswers(host), 'host', host);
});

function call(url, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('the state band, the console page and fuli status show the runtime and which computer each project belongs to', async (t) => {
  const dataDir = follower(t);
  writeRecord(dataDir, { state: 'failed', code: 'neo4j_start_failed', message: 'synthetic: Neo4j did not start', createdHere: true });
  const store = new RunnerStore(path.join(dataDir, RUNNER_FILE));
  // A folder the host answered a task entry for, and a project routed to the host by hand.
  store.rememberAnswer('entry:codex:/synthetic/widgets', 'get_collaboration_preferences',
    { structuredContent: { context: { personal_project_id: 'widgets' } } });
  const routes = openRoutes(dataDir);
  routes.set('project:notes', hostOwner(HOST.fingerprint));
  routes.close();
  const prepared = [];
  const entry = await startFollowerConsole({ dataDir, port: 0, store, connection: NOWHERE,
    prepare: (input) => { prepared.push(input); return true; } });
  t.after(async () => { await entry.close(); store.close(); });

  const answered = await call(`${entry.url}${STATUS_PATH}`, { headers: { host: new URL(entry.url).host } });
  assert.equal(answered.headers['x-fuli-source'], 'local', 'this computer\'s own answer, never the host\'s');
  const state = JSON.parse(answered.text);
  assert.equal(state.localRuntime.state, 'failed');
  assert.deepEqual(state.projects.map(({ id, where, ownerName, byDefault }) => ({ id, where, ownerName, byDefault })), [
    { id: 'notes', where: 'host', ownerName: 'Host A', byDefault: false },
    { id: 'widgets', where: 'host', ownerName: 'Host A', byDefault: true }]);
  assert.match(state.line.zh, /本机运行时准备失败$/, 'the band\'s one line says it');

  const page = followerConsolePage({ status: state, hostPath: '/remote/host-a/' });
  assert.match(page, /本机运行时/);
  assert.match(page, /data-prepare>重新准备/, 'the one next step, as a button');
  assert.match(page, /主机 Host A/);
  assert.doesNotMatch(page.split('<h2>本机运行时')[1].split('<h2>什么跑在哪里')[0], /fuli |<code>fuli/,
    'no command to type in the new sections');

  const text = formatFollowerResult('status', { status: 'running', url: entry.url, ...state });
  assert.match(text, /This computer's own runtime: the preparation did not succeed/);
  assert.match(text, /Prepare again/);
  assert.match(text, /project:widgets {2}主机 Host A \/ host Host A \(as new folders go/);

  // 「重新准备」 from this computer's own page only, answered at once.
  const origin = entry.url;
  const refused = await call(`${entry.url}${PREPARE_PATH}`, { method: 'POST', headers: { host: new URL(entry.url).host } });
  assert.equal(refused.status, 405, 'a program without this page\'s origin');
  const again = await call(`${entry.url}${PREPARE_PATH}`, { method: 'POST', headers: { host: new URL(entry.url).host, origin } });
  assert.equal(again.status, 202);
  assert.equal(JSON.parse(again.text).localRuntime.state, 'preparing');
  assert.deepEqual(prepared, [{ dataDir, again: true }]);
});

test('followerStatus reads this computer\'s own side without asking the host', async (t) => {
  const dataDir = follower(t);
  const store = new RunnerStore(path.join(dataDir, RUNNER_FILE));
  t.after(() => store.close());
  let hellos = 0;
  const state = await followerStatus({ store, connection: { ...NOWHERE, hello: async () => { hellos += 1; return null; } },
    dataDir, reach: false });
  assert.equal(hellos, 0);
  assert.equal(state.localRuntime.state, 'not_prepared');
  assert.deepEqual(state.projects, []);
});

test('joining again works over a graph this computer prepared and found empty, never over one with the person\'s data', async (t) => {
  const dataDir = follower(t);
  writeFileSync(path.join(dataDir, 'graph-runtime.json'), '{"synthetic":true}');
  const notOwnFuli = (error) => error?.code !== 'runner_has_own_fuli';
  writeRecord(dataDir, { state: 'ready', createdHere: true, projects: [] });
  // Past the check, the synthetic invitation itself is what fails.
  await assert.rejects(joinHost({ dataDir, invitation: 'not-an-invitation' }), notOwnFuli);
  writeRecord(dataDir, { state: 'ready', createdHere: true, projects: ['widgets'] });
  await assert.rejects(joinHost({ dataDir, invitation: 'not-an-invitation' }), { code: 'runner_has_own_fuli' });
  writeRecord(dataDir, { state: 'ready', createdHere: false, projects: [] });
  await assert.rejects(joinHost({ dataDir, invitation: 'not-an-invitation' }), { code: 'runner_has_own_fuli' });
  // Under way, the reason is that, not a FULI of its own.
  writeRecord(dataDir, { state: 'preparing', pid: 4242, createdHere: true });
  const holder = holdPreparationLock(dataDir);
  try {
    await assert.rejects(joinHost({ dataDir, invitation: 'not-an-invitation' }),
      (error) => error.code === 'local_runtime_preparing' && /正在后台准备本机运行时/.test(error.message));
  } finally { holder(); }
});

test('starting the data directory as its own FULI forgets what the follower recorded of its graph', async (t) => {
  const dataDir = follower(t);
  writeRecord(dataDir, { state: 'ready', createdHere: true, projects: [] });
  await runLocalRuntimeCommand('start', ['--data-dir', dataDir], { isRunner: () => false, write: () => {},
    start: async () => ({ status: 'running', url: 'http://127.0.0.1:2727' }), detectAgents: async () => ({ status: 'available', agents: [] }) });
  assert.equal(existsSync(path.join(dataDir, RECORD_FILE)), false);
});
