import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { previewMigrations } from '../src/data-format/migration-plan.js';
import { handleApiRequest } from '../src/http/api-router.js';
import { rejectRequestOutsidePolicy } from '../src/http/request-policy.js';
import { liveMcpProcesses, registerMcpProcess } from '../src/mcp/process-registry.js';
import { createDoctor } from '../src/system/doctor.js';
import { createDoctorRepair } from '../src/system/doctor-repair.js';
import { createSystemService } from '../src/system/system-service.js';
import { FULI_VERSION } from '../src/package-metadata.js';

// FULI's 体检 and its repair. Synthetic temporary data directories and fake
// sources only: no real data directory, no client configuration, no port.

const VERSION = '0.22.0';
const CHECKED_AT = new Date('2026-10-28T08:00:00.000Z');

function dataDir(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-doctor-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const client = (id, status, extra = {}) => ({ id, label: id.toUpperCase(), detected: true, status,
  previouslyConnected: ['connected', 'changed', 'removed'].includes(status), since: null, changes: [], ...extra });

const graph = (plan) => ({ preview: async () => ({ plan, undoable: [] }) });

function doctor(t, sources = {}) {
  const root = dataDir(t);
  return createDoctor({
    observeClients: () => ({ clients: [] }),
    previewDataFormats: () => previewMigrations({ dataDir: root, graph: graph(null) }),
    liveProcesses: () => [],
    latestVersion: () => null,
    lastUpdate: () => null,
    version: VERSION,
    now: () => CHECKED_AT,
    ...sources
  });
}

test('the doctor names each finding with who fixes it, and a blocking one degrades FULI', async (t) => {
  const root = dataDir(t);
  const runtimeConfigPath = join(root, 'graph-runtime.json');
  const live = new Set([101, 102, 103, 104]);
  const isAlive = (pid) => live.has(pid);
  const first = registerMcpProcess(runtimeConfigPath, { sourceApplication: 'codex', version: '0.21.0', pid: 101 });
  first.recordSession('thread-a');
  first.recordSession('thread-b');
  // A server that never answered a call still counts, without a session.
  registerMcpProcess(runtimeConfigPath, { sourceApplication: 'codex', version: '0.21.0', pid: 102 });
  registerMcpProcess(runtimeConfigPath, { sourceApplication: 'claude_code', version: VERSION, pid: 103 }).recordSession('current');
  // Two servers of one session name it once.
  registerMcpProcess(runtimeConfigPath, { sourceApplication: 'codex', version: '0.21.0', pid: 104 }).recordSession('thread-b');
  registerMcpProcess(runtimeConfigPath, { sourceApplication: 'codex', version: '0.20.0', pid: 105 }).recordSession('gone');
  const checkup = doctor(t, {
    observeClients: () => ({ clients: [
      client('codex', 'changed'),
      client('opencode', 'skills_left', { previouslyConnected: true, manualOnly: true }),
      // Skills a client never connected to FULI has: no finding, never connected by a repair.
      client('cursor', 'skills_left'),
      client('claude_code', 'connected'),
      client('gemini', 'not_connected')
    ] }),
    previewDataFormats: () => previewMigrations({ dataDir: root, graph: graph({ store: 'graph', kind: 'neo4j',
      action: 'apply', automatic: [], step: { id: 'graph-0007-backfill', count: 3 }, digest: 'a'.repeat(64) }) }),
    liveProcesses: () => liveMcpProcesses(runtimeConfigPath, { isAlive }),
    latestVersion: () => ({ status: 'ready', currentVersion: VERSION, latestVersion: '0.23.0', updateAvailable: true }),
    lastUpdate: () => ({ id: 'u1', status: 'updated', kind: 'windows-tray', fromVersion: '0.21.0', version: VERSION,
      clients: 'not_reconnected' })
  });

  assert.deepEqual(await checkup.check(), {
    checkedAt: '2026-10-28T08:00:00.000Z',
    version: VERSION,
    overall: 'degraded',
    items: [
      { id: 'data_format_waiting:graph (personal)', kind: 'data_format_waiting', severity: 'blocking', fix: 'person',
        data: { store: 'graph', label: 'graph (personal)', steps: ['graph-0007-backfill'] } },
      { id: 'client_outdated:codex', kind: 'client_outdated', severity: 'warning', fix: 'auto',
        data: { clientId: 'codex', label: 'CODEX', status: 'changed' } },
      { id: 'client_outdated:opencode', kind: 'client_outdated', severity: 'warning', fix: 'person',
        data: { clientId: 'opencode', label: 'OPENCODE', status: 'skills_left' } },
      { id: 'sessions_outdated:codex:0.21.0', kind: 'sessions_outdated', severity: 'warning', fix: 'person',
        data: { client: 'codex', count: 3, runningVersion: '0.21.0', sessions: [
          { sourceApplication: 'codex', sessionId: 'thread-a' }, { sourceApplication: 'codex', sessionId: 'thread-b' }] } },
      { id: 'update_left_work', kind: 'update_left_work', severity: 'warning', fix: 'auto',
        data: { updateId: 'u1', status: 'updated', clients: 'not_reconnected', version: VERSION } },
      { id: 'update_available', kind: 'update_available', severity: 'info', fix: 'person', data: { latest: '0.23.0' } }
    ],
    unchecked: [],
    uncheckedReasons: {}
  });
  // The exited server's record went away on the way.
  assert.deepEqual(liveMcpProcesses(runtimeConfigPath, { isAlive }).map(({ pid }) => pid), [101, 102, 103, 104]);
});

test('an outdated item names at most 20 sessions', async (t) => {
  const sessionIds = Array.from({ length: 8 }, (_, index) => `thread-${index}`);
  const processes = [1, 2, 3].map(pid => ({ pid, version: '0.21.0', sourceApplication: 'codex',
    sessionIds: sessionIds.map(id => `${pid}-${id}`) }));
  const { items } = await doctor(t, { liveProcesses: () => processes }).check();
  const outdated = items.find(({ kind }) => kind === 'sessions_outdated');
  assert.equal(outdated.data.count, 3);
  assert.equal(outdated.data.sessions.length, 20);
  assert.deepEqual(outdated.data.sessions[0], { sourceApplication: 'codex', sessionId: '1-thread-0' });
});

test('ports the running console moved by itself are one info item named after that start', async (t) => {
  const moves = [{ key: 'console', from: 2727, to: 2734, reason: 'reserved' }];
  const moved = await doctor(t, { portMoves: () => ({ movedAt: '2026-10-27T08:00:00.000Z', moves }) }).check();
  assert.equal(moved.overall, 'ok');
  assert.deepEqual(moved.items, [{ id: 'ports_moved:2026-10-27T08:00:00.000Z', kind: 'ports_moved', severity: 'info',
    fix: 'person', data: { movedAt: '2026-10-27T08:00:00.000Z', moves } }]);

  assert.deepEqual((await doctor(t, { portMoves: () => null }).check()).items, []);
  const unreadable = await doctor(t, { portMoves: () => { throw new Error('unreadable'); } }).check();
  assert.deepEqual(unreadable.unchecked, ['runtime']);
});

test('the console reads the moved ports from its runtime state', async (t) => {
  const root = dataDir(t);
  const moves = [{ key: 'console', from: 2727, to: 2734, reason: 'reserved' }];
  writeFileSync(join(root, 'graph-runtime-state.json'), JSON.stringify({ version: 4, pid: 1, url: 'http://127.0.0.1:2734',
    port: 2734, startedAt: '2026-10-27T08:00:00.000Z', portMoves: moves }));
  const paths = { dataDir: root, graphRuntimeConfigPath: join(root, 'graph-runtime.json'),
    graphRuntimeStatePath: join(root, 'graph-runtime-state.json') };
  const service = createSystemService({ paths, packageRoot: '.', settingsApplier: {}, resourceMonitor: {}, runtimeBroker: {},
    clientObserver: { observe: () => ({ clients: [] }) }, clientInstaller: async () => assert.fail('nothing to connect'),
    versionChecker: { peek: () => null, check: async () => assert.fail('the doctor never waits on the network') },
    update: { status: () => null, kind: () => 'npm' },
    previewDataFormats: async () => ({ digest: null, stores: [], blocked: [], undoable: [] }) });
  const answer = await service.doctor();
  assert.deepEqual(answer.unchecked, []);
  assert.deepEqual(answer.items.filter(({ kind }) => kind === 'ports_moved').map(({ id, data }) => ({ id, data })),
    [{ id: 'ports_moved:2026-10-27T08:00:00.000Z', data: { movedAt: '2026-10-27T08:00:00.000Z', moves } }]);
});
const SLEEPING_GRAPH = { store: 'graph', kind: 'neo4j', action: 'unavailable', steps: [], reason: 'its provider is not answering' };
const WAITING_GRAPH = { store: 'graph', kind: 'neo4j', action: 'apply', automatic: [],
  step: { id: 'graph/12-builtin-occupations', count: 4 }, digest: 'b'.repeat(64) };

test('info alone leaves FULI ok; a graph never seen answering is unchecked with why; a failing source is named', async (t) => {
  const quiet = doctor(t, {
    previewDataFormats: () => previewMigrations({ dataDir: dataDir(t), graph: graph(SLEEPING_GRAPH) }),
    graphStage: () => 'provider-sleeping',
    latestVersion: () => ({ status: 'ready', latestVersion: '0.23.0', updateAvailable: true })
  });
  const answer = await quiet.check();
  assert.equal(answer.overall, 'ok');
  assert.deepEqual(answer.items.map(({ kind }) => kind), ['update_available']);
  assert.deepEqual(answer.unchecked, ['graph_format']);
  assert.deepEqual(answer.uncheckedReasons, { graph_format: 'graph_sleeping' });
  const broken = doctor(t, { previewDataFormats: () => previewMigrations({ dataDir: dataDir(t), graph: graph(SLEEPING_GRAPH) }),
    graphStage: () => 'awake' });
  assert.deepEqual((await broken.check()).uncheckedReasons, { graph_format: 'graph_not_answering' });

  const failing = doctor(t, {
    observeClients: () => { throw new Error('unreadable'); },
    latestVersion: () => { throw new Error('no checker'); },
    lastUpdate: () => ({ id: 'u2', status: 'failed', fromVersion: VERSION, targetVersion: '0.23.0', error: 'The tray did not exit.' })
  });
  const partial = await failing.check();
  assert.deepEqual(partial.unchecked, ['clients', 'update']);
  assert.equal(partial.overall, 'needs_person');
  assert.deepEqual(partial.items, [{ id: 'update_left_work', kind: 'update_left_work', severity: 'warning', fix: 'person',
    data: { updateId: 'u2', status: 'failed', targetVersion: '0.23.0', error: 'The tray did not exit.' } }]);
});

test('a blocked store degrades FULI; an update journal of another version is no finding', async (t) => {
  const checkup = doctor(t, {
    previewDataFormats: async () => ({ digest: null, stores: [], undoable: [], blocked: [
      { label: 'roundtable', store: 'roundtable', kind: 'sqlite', action: 'blocked', steps: ['rt-0004'],
        reason: 'written by a newer FULI (format 5); upgrade FULI or restore a backup' }] }),
    lastUpdate: () => ({ id: 'u3', status: 'updated', version: '0.21.0', clients: 'not_reconnected' })
  });
  const answer = await checkup.check();
  assert.equal(answer.overall, 'degraded');
  assert.deepEqual(answer.items, [{ id: 'data_format_blocked:roundtable', kind: 'data_format_blocked', severity: 'blocking',
    fix: 'person', data: { store: 'roundtable', label: 'roundtable', steps: ['rt-0004'],
      reason: 'written by a newer FULI (format 5); upgrade FULI or restore a backup' } }]);
  const failedElsewhere = doctor(t, { lastUpdate: () => ({ id: 'u4', status: 'failed', fromVersion: '0.21.0', error: 'x' }) });
  assert.deepEqual((await failedElsewhere.check()).items, []);
});

test('a graph step seen waiting stays a finding while the provider sleeps, until a graph operation is recorded', async (t) => {
  const root = dataDir(t);
  let answer = WAITING_GRAPH;
  let operations = [];
  let clock = new Date('2026-10-31T09:00:00.000Z');
  const checkup = doctor(t, {
    previewDataFormats: () => previewMigrations({ dataDir: root, graph: graph(answer) }),
    formatOperations: () => operations,
    graphStage: () => 'sleeping',
    now: () => clock
  });
  const seen = await checkup.check();
  assert.deepEqual(seen.items.map(({ id }) => id), ['data_format_waiting:graph (personal)']);
  assert.deepEqual(seen.unchecked, []);

  answer = SLEEPING_GRAPH;
  clock = new Date('2026-10-31T10:00:00.000Z');
  const asleep = await checkup.check();
  assert.equal(asleep.overall, 'degraded');
  assert.deepEqual(asleep.items, [{ id: 'data_format_waiting:graph (personal)', kind: 'data_format_waiting', severity: 'blocking',
    fix: 'person', data: { store: 'graph', label: 'graph (personal)', steps: ['graph/12-builtin-occupations'],
      lastSeenAt: '2026-10-31T09:00:00.000Z' } }]);
  assert.deepEqual(asleep.uncheckedReasons, { graph_format: 'graph_sleeping' });

  // A local store's operation says nothing about the graph.
  operations = [{ kind: 'applied', store: 'roundtable', label: 'roundtable', migrationId: 'rt-0004', at: '2026-10-31T09:30:00.000Z' }];
  assert.equal((await checkup.check()).items.length, 1);
  // Confirmed in the console after it was seen: the remembered answer is stale.
  operations.push({ kind: 'applied', store: 'graph', label: 'graph (personal)', migrationId: 'graph/12-builtin-occupations',
    at: '2026-10-31T09:40:00.000Z' });
  const confirmed = await checkup.check();
  assert.deepEqual(confirmed.items, []);
  assert.deepEqual(confirmed.unchecked, ['graph_format']);
  // A graph that answers with nothing waiting replaces what was remembered.
  answer = null;
  assert.deepEqual((await checkup.check()).unchecked, []);
});

test('a client whose host keeps its hook trust unreadable is named unchecked, never guessed', async (t) => {
  const checkup = doctor(t, {
    hookTrustUnreadable: ['codex'],
    observeClients: () => ({ clients: [client('codex', 'connected'), client('claude_code', 'connected')] })
  });
  const answer = await checkup.check();
  assert.equal(answer.overall, 'ok');
  assert.deepEqual(answer.items, []);
  assert.deepEqual(answer.unchecked, ['hook_trust:codex']);
  assert.deepEqual(answer.uncheckedReasons, { 'hook_trust:codex': 'host_trust_unreadable' });
  // Without FULI's integration there are no FULI hooks to trust.
  const absent = doctor(t, { hookTrustUnreadable: ['codex'],
    observeClients: () => ({ clients: [client('codex', 'not_connected')] }) });
  assert.deepEqual((await absent.check()).unchecked, []);
});

// A client installer and update journal in memory: what each repair did.
function repairFixture(t, { clients, update = null, install = async ({ clientId }) => ({ id: clientId, status: 'connected' }) }) {
  const state = { clients, update, connects: [] };
  const checkup = doctor(t, { observeClients: () => ({ clients: state.clients }), lastUpdate: () => state.update });
  const repair = createDoctorRepair({
    check: checkup.check,
    observeClients: () => ({ clients: state.clients }),
    connectClient: async (input) => {
      state.connects.push(input.clientId);
      const result = await install(input);
      if (result.status === 'connected') state.clients = state.clients.map((entry) => entry.id === input.clientId
        ? { ...entry, status: 'connected' } : entry);
      return result;
    },
    recordClientsReconnected: (id) => { if (state.update?.id === id) state.update = { ...state.update, clients: 'reconnected' }; }
  });
  return { state, repair };
}

test('the repair reconnects outdated clients and finishes an update\'s reconnection, each client once', async (t) => {
  const { state, repair } = repairFixture(t, {
    clients: [client('codex', 'changed'), client('claude_code', 'connected'), client('cursor', 'skills_left'),
      client('opencode', 'changed', { manualOnly: true }), client('gemini', 'removed')],
    update: { id: 'u1', status: 'updated', version: VERSION, clients: 'not_reconnected' }
  });
  const outcome = await repair();
  assert.deepEqual(outcome.results, [
    { id: 'client_outdated:codex', outcome: 'fixed' },
    { id: 'update_left_work', outcome: 'fixed' }
  ]);
  // Never a client that was not connected, a removed one, or a manual-only one.
  assert.deepEqual(state.connects, ['codex', 'claude_code']);
  assert.equal(state.update.clients, 'reconnected');
  assert.deepEqual(outcome.doctor.items.map(({ id, fix }) => [id, fix]), [['client_outdated:opencode', 'person']]);
});

test('a reconnection that fails is reported without paths, and the update\'s work stays open', async (t) => {
  const { state, repair } = repairFixture(t, {
    clients: [client('codex', 'changed'), client('claude_code', 'connected')],
    update: { id: 'u1', status: 'updated', version: VERSION, clients: 'not_reconnected' },
    install: async ({ clientId }) => {
      if (clientId === 'codex') throw new Error('EACCES: permission denied, open C:\\Users\\someone\\.codex\\config.toml');
      return { id: clientId, status: 'partial' };
    }
  });
  const outcome = await repair();
  const error = 'The client could not be reconnected; connect it again in Settings → Clients.';
  assert.deepEqual(outcome.results, [
    { id: 'client_outdated:codex', outcome: 'failed', error },
    { id: 'update_left_work', outcome: 'failed', error }
  ]);
  assert.equal(state.update.clients, 'not_reconnected');
  assert.equal(outcome.doctor.overall, 'needs_person');
});

test('only one repair runs at a time', async (t) => {
  let release;
  const { repair } = repairFixture(t, { clients: [client('codex', 'changed')],
    install: ({ clientId }) => new Promise((resolve) => { release = () => resolve({ id: clientId, status: 'connected' }); }) });
  const first = repair();
  await assert.rejects(repair(), /already running/);
  while (!release) await new Promise(setImmediate);
  release();
  assert.deepEqual((await first).results, [{ id: 'client_outdated:codex', outcome: 'fixed' }]);
});

function exchange(method, path, { remoteAddress = '127.0.0.1', body = '', headers = {} } = {}) {
  const sent = [];
  const response = { setHeader() {}, writeHead(status) { sent.push(status); return this; }, end(text) { sent.push(JSON.parse(text)); } };
  const request = { method, url: path, headers, socket: { remoteAddress },
    async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(body); } };
  return { request, response, sent };
}

test('the doctor is read like any console read; its repair only from this computer, with no options', async () => {
  let repairs = 0;
  const system = { doctor: async () => ({ overall: 'ok', items: [] }),
    repairDoctor: async () => { repairs += 1; return { results: [], doctor: { overall: 'ok', items: [] } }; } };
  const call = async (method, path, options) => {
    const { request, response, sent } = exchange(method, path, options);
    assert.equal(await handleApiRequest({ request, response, app: {}, system }), true);
    return sent;
  };
  assert.deepEqual(await call('GET', '/api/system/doctor', { remoteAddress: '192.168.1.20' }), [200, { overall: 'ok', items: [] }]);
  assert.deepEqual(await call('POST', '/api/system/doctor/repair', { remoteAddress: '192.168.1.20', body: '{}' }),
    [403, { error: 'FULI is repaired only on this computer', code: 'local_user_only' }]);
  assert.deepEqual(await call('GET', '/api/system/doctor/repair'), [405, { error: 'Method not allowed' }]);
  assert.deepEqual(await call('POST', '/api/system/doctor'), [405, { error: 'Method not allowed' }]);
  await assert.rejects(call('POST', '/api/system/doctor/repair', { body: '{"clientId":"codex"}' }), /takes no options/);
  assert.equal(repairs, 0);
  assert.deepEqual(await call('POST', '/api/system/doctor/repair', { body: '{}' }),
    [200, { results: [], doctor: { overall: 'ok', items: [] } }]);
  assert.equal(repairs, 1);
});

test('the version route answers from the cache when asked to, and only then', async () => {
  const cached = { status: 'ready', latestVersion: '0.24.0', updateAvailable: true };
  const system = { cachedVersionStatus: () => cached, versionStatus: async () => ({ status: 'ready', fresh: true }) };
  const call = async (path) => {
    const { request, response, sent } = exchange('GET', path);
    assert.equal(await handleApiRequest({ request, response, app: {}, system }), true);
    return sent;
  };
  assert.deepEqual(await call('/api/system/version?cached=1'), [200, cached]);
  assert.deepEqual(await call('/api/system/version'), [200, { status: 'ready', fresh: true }]);
});

test('the repair request also passes the console\'s Host, Origin and JSON policy', () => {
  const authority = '127.0.0.1:4567';
  const refused = (headers) => {
    const { request, response, sent } = exchange('POST', '/api/system/doctor/repair', { headers: { host: authority, ...headers } });
    return rejectRequestOutsidePolicy({ request, response, authority }) ? sent[0] : null;
  };
  assert.equal(refused({ 'content-type': 'application/json' }), null);
  assert.equal(refused({ 'content-type': 'text/plain' }), 415);
  assert.equal(refused({ 'content-type': 'application/json', origin: 'http://evil.example' }), 403);
  assert.equal(refused({ 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }), 403);
});

test('the system service reads its own sources: this data directory\'s live servers and the cached version only', async (t) => {
  const root = dataDir(t);
  const paths = { dataDir: root, graphRuntimeConfigPath: join(root, 'graph-runtime.json'),
    graphRuntimeStatePath: join(root, 'graph-runtime-state.json') };
  // This test process stands in for a live MCP server of an older FULI.
  registerMcpProcess(paths.graphRuntimeConfigPath, { sourceApplication: 'codex', version: '0.0.1', pid: process.pid });
  let clients = [client('codex', 'changed')];
  const connects = [];
  const system = createSystemService({ paths, packageRoot: '.', settingsApplier: {}, resourceMonitor: {}, runtimeBroker: {},
    clientObserver: { observe: () => ({ clients }) },
    clientInstaller: async ({ clientId }) => {
      connects.push(clientId);
      clients = clients.map((entry) => ({ ...entry, status: 'connected' }));
      return { id: clientId, status: 'connected', restartRequired: true };
    },
    versionChecker: { peek: () => null, check: async () => assert.fail('the doctor never waits on the network') },
    update: { status: () => null, kind: () => 'npm' },
    previewDataFormats: async () => ({ digest: null, stores: [], blocked: [], undoable: [] }) });

  const answer = await system.doctor();
  assert.equal(answer.version, FULI_VERSION);
  assert.deepEqual(answer.items.map(({ id }) => id), ['client_outdated:codex', 'sessions_outdated:codex:0.0.1']);
  assert.deepEqual(answer.unchecked, ['hook_trust:codex']);
  // `fuli status` reads the same cached answer: before the first one, nothing is known.
  assert.deepEqual(system.cachedVersionStatus(), { status: 'unchecked' });
  const repaired = await system.repairDoctor();
  assert.deepEqual(repaired.results, [{ id: 'client_outdated:codex', outcome: 'fixed' }]);
  assert.deepEqual(connects, ['codex']);
  assert.deepEqual(repaired.doctor.items.map(({ id }) => id), ['sessions_outdated:codex:0.0.1']);
});
