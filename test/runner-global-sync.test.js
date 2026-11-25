import { requestSyncSoon } from '../src/runner/global-copy-state.js';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { createDeviceCertificate, deviceIdentity } from '../packages/roundtable/src/peer/device-identity.js';
import { runRunnerCommand } from '../src/cli/runner-command.js';
import { openRoutes } from '../src/runner/call-routes.js';
import { holdPreparationLock, writeRecord } from '../src/runner/follower-local-runtime.js';
import { followerConsolePage } from '../src/runner/follower-page.js';
import { formatFollowerResult } from '../src/runner/follower-runtime.js';
import { followerLine, followerStatus } from '../src/runner/follower-status.js';
import { COPY_FILE, describeGlobalCopy, globalCopyLine, IMPORT_UNFINISHED, readGlobalCopyRecord, recordGlobalCopy } from '../src/runner/global-copy-state.js';
import { DIGEST_REFUSAL_AGAIN_MS, startGlobalSync, syncFromPreparation, syncGlobalCopy } from '../src/runner/global-sync.js';
import { createHostConnection } from '../src/runner/host-connection.js';
import { startRunnerListener } from '../src/runner/host-listener.js';
import { createRunnerRoutes } from '../src/runner/host-routes.js';
import { createScopeExport } from '../src/runner/host-scope-export.js';
import { RunnerHostStore } from '../src/runner/host-store.js';
import { ownDataHere, setAsideHostCopy } from '../src/runner/leave-global-copy.js';
import { RUNNER_PATHS, SCOPE_DIGEST_HEADER } from '../src/runner/protocol.js';
import { GLOBAL_SCOPE } from '../src/runner/routes-store.js';
import { RUNNER_FILE, RunnerStore } from '../src/runner/runner-store.js';
import { resolveSetupPaths } from '../src/setup/paths.js';

// Nothing here starts a real process (runner-local-runtime.test.js): no Neo4j, Provider or child.
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  mock.method(childProcess, name, () => { throw new Error(`a test of this file started a real process (${name})`); });
}
syncBuiltinESMExports();

// docs/runner-roles-design.md §12 "The sync loop": a follower's read-only copy of its host's global.
// Synthetic computers and records only.
const HOST_SPACE_ID = '0f0e0d0c-0b0a-4909-8807-060504030201';
const OTHER_SPACE_ID = '11111111-2222-4333-8444-555555555555';
const FORMATS = Object.freeze({ graph: 25, replicaProtocol: 1 });
const KNOWN = Object.freeze({ known: true, spaceId: HOST_SPACE_ID, providerId: 'local-personal', graphFormat: 25, replicaProtocol: 1 });

// An envelope as a Provider writes it: numbers JavaScript would write otherwise (0.0, 1e-05) and text beyond ASCII.
function envelopeText(digest = 'd'.repeat(64), { name = 'Synthetic Grüße 你好 é', spaceId = HOST_SPACE_ID, graphFormat = 25,
  complete = true } = {}) {
  return `{"complete":${complete},"digest":"${digest}","graphFormat":${graphFormat},"nodes":[{"id":"Entity:synthetic-habit",`
    + `"labels":["Entity"],"properties":{"count":12345678901234567890,"name":"${name}","name_embedding":[0.0,1.0,1e-05,-2.5E+3]}}],`
    + `"owner":"${'e'.repeat(64)}","replicaProtocol":1,"scope":"global","spaceId":"${spaceId}"}`;
}
// What GraphitiProviderClient.exportScope answers for that text.
function exportedOf(text) {
  const envelope = JSON.parse(text);
  return Object.freeze({ text, scope: envelope.scope, spaceId: envelope.spaceId, digest: envelope.digest,
    complete: envelope.complete, graphFormat: envelope.graphFormat, replicaProtocol: envelope.replicaProtocol,
    bytes: Buffer.byteLength(text) });
}

function hostApp(exportScope) {
  return { config: { personal: { spaceId: HOST_SPACE_ID } },
    personal: { exportScope, health: async () => ({ providerId: 'local-personal', replicaProtocol: 1,
      data_format: { supported_version: 25 } }) } };
}

// A follower's data directory: paired with the host (routes global → host), and a graph made under `spaceId`.
function followerDir(t, hostFingerprint, { spaceId = HOST_SPACE_ID, running = false } = {}) {
  const dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'fuli-global-sync-')));
  t.after(() => rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 }));
  mkdirSync(path.join(dataDir, 'runner'), { recursive: true });
  const store = new RunnerStore(path.join(dataDir, RUNNER_FILE));
  store.saveHost({ name: 'Host A', fingerprint: hostFingerprint, certPem: 'synthetic', port: 2730, addresses: ['192.0.2.20'] });
  store.close();
  writeFileSync(path.join(dataDir, 'graph-runtime.json'), JSON.stringify({ version: 1, personal: { spaceId } }));
  writeRecord(dataDir, { state: 'ready', at: '2026-11-24T08:00:00.000Z', createdHere: true, running, projects: [],
    space: { state: 'same', id: spaceId }, formats: FORMATS });
  openRoutes(dataDir).close();
  return dataDir;
}

// The host's runner routes behind the real TLS listener, and a paired follower's connection to it.
async function pairedOverTls(t, app, { pair = true } = {}) {
  const [host, runner] = await Promise.all([createDeviceCertificate(), createDeviceCertificate()]
    .map(async (made) => deviceIdentity(await made)));
  const hostStore = new RunnerHostStore(':memory:');
  if (pair) {
    hostStore.invite({ code: 'synthetic-invitation-code-0042', name: 'Runner B' });
    hostStore.pair({ code: 'synthetic-invitation-code-0042', fingerprint: runner.fingerprint, name: 'Runner B' });
  }
  const routes = createRunnerRoutes({ app, store: hostStore, hostName: 'Host A', hostFingerprint: host.fingerprint,
    withLease: (_owner, operation) => operation() });
  const listener = await startRunnerListener({ identity: host, addresses: ['127.0.0.1'], port: 0, sourceAllowed: () => true,
    route: routes.handle });
  const dataDir = followerDir(t, host.fingerprint);
  const store = new RunnerStore(path.join(dataDir, RUNNER_FILE));
  store.saveHost({ name: 'Host A', fingerprint: host.fingerprint, certPem: host.certPem, port: listener.port, addresses: ['127.0.0.1'] });
  const connection = createHostConnection({ store, identity: runner, lookUp: async () => [], bindAddresses: () => [] });
  // Let go of everything before the folder goes (t.after runs in order, and the folder hook came first).
  const close = async () => {
    connection.close();
    store.close();
    await routes.close();
    await listener.close();
    hostStore.close();
  };
  return { host, dataDir, store, connection, close };
}

// A connection that answers the scope route from a table, recording what was asked.
function scriptedConnection(answers) {
  const asked = [];
  return { asked, current: null,
    getText: async (pathName) => {
      const part = new URL(pathName, 'https://x.invalid').searchParams.get('part');
      asked.push(part);
      const answer = answers[part];
      return typeof answer === 'function' ? answer() : answer;
    } };
}
const digestAnswer = (text) => {
  const { scope, spaceId, digest, complete, graphFormat, replicaProtocol, bytes } = exportedOf(text);
  return { reachable: true, status: 200, text: JSON.stringify({ scope, spaceId, digest, complete, graphFormat, replicaProtocol, bytes }) };
};
const envelopeAnswer = (text) => ({ reachable: true, status: 200, text,
  headers: new Headers({ [SCOPE_DIGEST_HEADER]: JSON.parse(text).digest }) });

async function withStore(dataDir, use) {
  const store = new RunnerStore(path.join(dataDir, RUNNER_FILE));
  try { return await use(store); } finally { store.close(); }
}

test('the host hands the envelope on byte for byte over the paired channel, and the follower imports those bytes', async (t) => {
  const text = envelopeText();
  let exports = 0;
  const { host, dataDir, store, connection, close } = await pairedOverTls(t,
    hostApp(async ({ personalSpaceId, scope }) => {
      exports += 1;
      assert.equal(personalSpaceId, HOST_SPACE_ID);
      assert.equal(scope, 'global');
      return exportedOf(text);
    }));
  try {
    const imported = [];
    const outcome = await syncGlobalCopy({ dataDir, store, connection, hostSpace: KNOWN, ownFormats: FORMATS,
      localSpaceId: HOST_SPACE_ID, importInto: async (input) => { imported.push(input); return { imported: { nodes: { created: 1 } } }; },
      now: () => Date.parse('2026-11-24T09:00:00.000Z') });
    assert.equal(outcome.outcome, 'synced');
    assert.equal(imported.length, 1);
    assert.ok(Buffer.from(imported[0].envelope, 'utf8').equals(Buffer.from(text, 'utf8')), 'not parsed and written again');
    assert.equal(imported[0].owner, host.fingerprint, 'the owner is the pinned fingerprint, never the envelope\'s `owner`');
    assert.equal(exports, 1, 'the digest and the envelope came from one export');
    const routes = openRoutes(dataDir);
    try {
      assert.deepEqual(routes.all().find((row) => row.scope === GLOBAL_SCOPE),
        { scope: 'global', owner: `host:${host.fingerprint}`, replica: true, replicaSyncedAt: '2026-11-24T09:00:00.000Z',
          folder: null, updatedAt: routes.all()[0].updatedAt });
    } finally { routes.close(); }
    assert.deepEqual(readGlobalCopyRecord(dataDir), { digest: 'd'.repeat(64), checkedAt: '2026-11-24T09:00:00.000Z',
      changedAt: '2026-11-24T09:00:00.000Z', last: { at: '2026-11-24T09:00:00.000Z', outcome: 'synced', digest: 'd'.repeat(64) } });
  } finally {
    await close();
  }
});

test('an unpaired computer is refused the scope route (403) and nothing is exported for it', async (t) => {
  let exports = 0;
  const { connection, close } = await pairedOverTls(t, hostApp(async () => { exports += 1; return exportedOf(envelopeText()); }),
    { pair: false });
  try {
    // The listener knows the certificate (pinned TLS) but the host store does not: runner_unknown.
    const answer = await connection.getText(`${RUNNER_PATHS.scope}?scope=global&part=digest`, { maxBytes: 1024 });
    assert.equal(answer.reachable, false, 'an unpaired follower finds no host');
    assert.equal(exports, 0);
  } finally {
    await close();
  }
  const routes = createRunnerRoutes({ app: hostApp(async () => { exports += 1; return exportedOf(envelopeText()); }),
    store: new RunnerHostStore(':memory:'), hostName: 'Host A', hostFingerprint: 'f'.repeat(64), withLease: (_o, operation) => operation() });
  const sent = [];
  const response = { headersSent: false, writeHead(status) { sent.push(status); return this; }, setHeader() {},
    end(body) { sent.push(String(body)); } };
  try {
    await routes.handle({ method: 'GET', url: `${RUNNER_PATHS.scope}?scope=global`, headers: {} }, response,
      { fingerprint: 'a'.repeat(64), pathname: RUNNER_PATHS.scope, address: '192.0.2.30' });
    assert.equal(sent[0], 403);
    assert.match(sent[1], /runner_unknown/);
    assert.equal(exports, 0, 'nothing was exported for it');
  } finally {
    await routes.close();
  }
});

test('the host answers the digest alone and exports a scope at most once per keep time', async () => {
  let exports = 0;
  let clock = 0;
  const release = Promise.withResolvers();
  const exported = exportedOf(envelopeText());
  const scope = createScopeExport({ app: hostApp(async () => { exports += 1; await release.promise; return exported; }),
    now: () => clock, keepMs: 60_000 });
  const asks = [scope.answer('global', 'digest'), scope.answer('global', 'envelope'), scope.answer('global', 'digest')];
  release.resolve();
  const [digest, envelope] = await Promise.all(asks);
  assert.equal(exports, 1, 'asks while one export runs wait for it');
  assert.deepEqual(digest, { status: 200, body: { scope: 'global', spaceId: HOST_SPACE_ID, digest: 'd'.repeat(64), complete: true,
    graphFormat: 25, replicaProtocol: 1, bytes: exported.bytes } });
  assert.equal(digest.body.text, undefined, 'no body in the digest answer');
  assert.equal(envelope.text, exported.text);
  clock = 59_000;
  await scope.answer('global', 'digest');
  assert.equal(exports, 1, 'kept for the keep time');
  clock = 60_000;
  await scope.answer('global', 'digest');
  assert.equal(exports, 2, 'exported again after it');
  assert.deepEqual(await scope.answer('project:synthetic', 'digest'),
    { status: 400, body: { error: 'scope_not_offered', message: 'Only global is copied in this version.' } });
});

test('a host past the size cap, without a Provider, with a slow one, or keeping only a copy says so with its own code', async () => {
  const big = createScopeExport({ app: hostApp(async () => exportedOf(envelopeText())), maxBytes: 100 });
  const tooLarge = await big.answer('global', 'envelope');
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.body.error, 'scope_too_large');
  assert.equal(tooLarge.text, undefined, 'never a cut envelope');

  const started = Date.now();
  const away = createScopeExport({ app: hostApp(async () => { throw Object.assign(new Error('unavailable'), { status: 0 }); }) });
  assert.deepEqual((await away.answer('global', 'digest')).body.error, 'host_provider_unavailable');
  assert.ok(Date.now() - started < 1000, 'at once');

  const slow = createScopeExport({ app: hostApp(() => new Promise(() => {})), waitMs: 20 });
  assert.deepEqual(await slow.answer('global', 'digest'), { status: 503,
    body: { error: 'host_provider_slow', message: 'This computer\'s graph is slow to export now; ask again later.' } });

  const copy = createScopeExport({ app: hostApp(async () => { throw Object.assign(new Error('a copy here'),
    { status: 409, code: 'scope_not_owned_here' }); }) });
  assert.deepEqual((await copy.answer('global', 'digest')).status, 409);
  assert.equal((await copy.answer('global', 'digest')).body.error, 'scope_not_owned_here', 'the Provider\'s refusal, as it said it');
  const follows = createScopeExport({ app: hostApp(async () => assert.fail('not exported')), ownsScope: () => false });
  assert.equal((await follows.answer('global', 'digest')).body.error, 'scope_not_owned_here');
});

test('an unchanged digest fetches no envelope and imports nothing; a changed one is fetched and imported', async (t) => {
  const dataDir = followerDir(t, 'a'.repeat(64));
  const first = envelopeText('1'.repeat(64));
  let imports = 0;
  const importInto = async () => { imports += 1; return { imported: {} }; };
  let clock = Date.parse('2026-11-24T09:00:00.000Z');
  const sync = (connection) => withStore(dataDir, (store) => syncGlobalCopy({ dataDir, store, connection, hostSpace: KNOWN,
    ownFormats: FORMATS, localSpaceId: HOST_SPACE_ID, importInto, now: () => clock }));
  assert.equal((await sync(scriptedConnection({ digest: digestAnswer(first), envelope: envelopeAnswer(first) }))).outcome, 'synced');
  clock += 10 * 60_000;
  const same = scriptedConnection({ digest: digestAnswer(first), envelope: () => assert.fail('no envelope for an unchanged digest') });
  const unchanged = await sync(same);
  assert.deepEqual(same.asked, ['digest']);
  assert.equal(unchanged.unchanged, true);
  assert.equal(imports, 1);
  const record = readGlobalCopyRecord(dataDir);
  assert.equal(record.checkedAt, '2026-11-24T09:10:00.000Z', 'checked now');
  assert.equal(record.changedAt, '2026-11-24T09:00:00.000Z', 'changed then');
  const second = envelopeText('2'.repeat(64));
  clock += 10 * 60_000;
  assert.equal((await sync(scriptedConnection({ digest: digestAnswer(second), envelope: envelopeAnswer(second) }))).outcome, 'synced');
  assert.equal(imports, 2);
  assert.equal(readGlobalCopyRecord(dataDir).changedAt, '2026-11-24T09:20:00.000Z');
});

test('a global access denial survives an offline round until a permitted envelope is imported', async (t) => {
  const dataDir = followerDir(t, 'a'.repeat(64));
  const envelope = envelopeText('1'.repeat(64));
  const allowed = () => scriptedConnection({ digest: digestAnswer(envelope), envelope: envelopeAnswer(envelope) });
  let clock = Date.parse('2026-11-24T09:00:00.000Z');
  const sync = (connection, hostSpace = KNOWN) => withStore(dataDir, store => syncGlobalCopy({
    dataDir, store, connection, hostSpace, ownFormats: FORMATS, localSpaceId: HOST_SPACE_ID,
    importInto: async () => ({ imported: {} }), now: () => clock }));
  await sync(allowed());
  const denied = () => scriptedConnection({ digest: { reachable: true, status: 403,
    text: JSON.stringify({ error: 'scope_grant_required' }) } });
  await sync(denied());
  await withStore(dataDir, store => store.denyGlobalCopy(store.host()));
  const deniedAt = new Date(clock).toISOString();
  clock += 600_000;
  assert.equal((await sync(scriptedConnection({}), { known: false, reason: 'scope_grant_required' })).code,
    'scope_grant_required');
  await sync(scriptedConnection({}), { known: false });
  assert.equal(describeGlobalCopy(dataDir).last.at, deniedAt);
  assert.equal(describeGlobalCopy(dataDir).last.code, 'scope_grant_required');
  assert.equal(readGlobalCopyRecord(dataDir).digest, null);
  const restored = allowed();
  assert.equal((await sync(restored)).outcome, 'synced');
  assert.deepEqual(restored.asked, ['digest', 'envelope']);
  assert.equal(describeGlobalCopy(dataDir).last.outcome, 'synced');
  await withStore(dataDir, store => assert.equal(store.host().globalDeniedAt, undefined));
});

test('different versions are not imported, nor asked for again and again; the state says which side to update', async (t) => {
  const dataDir = followerDir(t, 'a'.repeat(64));
  const nothing = scriptedConnection({});
  const outcome = await withStore(dataDir, (store) => syncGlobalCopy({ dataDir, store, connection: nothing,
    hostSpace: { ...KNOWN, graphFormat: 26 }, ownFormats: FORMATS, localSpaceId: HOST_SPACE_ID,
    importInto: async () => assert.fail('not imported') }));
  assert.equal(outcome.outcome, 'versions_differ');
  assert.deepEqual(nothing.asked, [], 'the hello said it: the host is not asked for the scope');
  const line = globalCopyLine({ checkedAt: null, last: readGlobalCopyRecord(dataDir).last, running: false, everyMinutes: 10 });
  assert.match(line.zh, /两台电脑的 FULI 版本不一致（主机：图谱格式 26、副本协议 1；这台电脑：25、1），没有同步。把这台电脑的 FULI 升级后继续。/);
  assert.doesNotMatch(line.zh, /`|fuli /, 'no terminal command');

  // The export itself says another format (a hello read minutes ago said the old one): no envelope either.
  const text = envelopeText('3'.repeat(64), { graphFormat: 24 });
  const told = scriptedConnection({ digest: digestAnswer(text), envelope: () => assert.fail('no envelope') });
  const fromExport = await withStore(dataDir, (store) => syncGlobalCopy({ dataDir, store, connection: told, hostSpace: KNOWN,
    ownFormats: FORMATS, localSpaceId: HOST_SPACE_ID, importInto: async () => assert.fail('not imported') }));
  assert.equal(fromExport.outcome, 'versions_differ');
  assert.match(globalCopyLine({ last: readGlobalCopyRecord(dataDir).last, everyMinutes: 10 }).zh, /把主机的 FULI 升级后继续/);
});

test('a refusal is recorded as said and not tried again until the digest changes', async (t) => {
  const dataDir = followerDir(t, 'a'.repeat(64));
  const text = envelopeText('4'.repeat(64));
  let imports = 0;
  const importInto = async () => { imports += 1;
    return { refused: 409, code: 'replica_scope_owned_here', message: 'synthetic: a record of this computer\'s own' }; };
  const sync = (connection) => withStore(dataDir, (store) => syncGlobalCopy({ dataDir, store, connection, hostSpace: KNOWN,
    ownFormats: FORMATS, localSpaceId: HOST_SPACE_ID, importInto }));
  const refused = await sync(scriptedConnection({ digest: digestAnswer(text), envelope: envelopeAnswer(text) }));
  assert.equal(refused.outcome, 'refused');
  assert.equal(refused.code, 'replica_scope_owned_here');
  assert.equal(refused.by, 'here');
  const line = globalCopyLine({ last: readGlobalCopyRecord(dataDir).last, everyMinutes: 10 });
  assert.match(line.zh, /这台电脑拒绝了这份副本（replica_scope_owned_here）/);
  assert.match(line.zh, /转发到主机的调用不受影响/);
  assert.doesNotMatch(line.zh, /不在线|连不上/, 'a refusal is never said as the host being away');

  const again = scriptedConnection({ digest: digestAnswer(text), envelope: () => assert.fail('the same refusal is not fetched again') });
  assert.equal((await sync(again)).repeated, true);
  assert.equal(imports, 1);
  const changed = envelopeText('5'.repeat(64));
  await sync(scriptedConnection({ digest: digestAnswer(changed), envelope: envelopeAnswer(changed) }));
  assert.equal(imports, 2, 'tried again once the host\'s content changed');
});

test('an earlier host without the route, one not answering, another space and a lock held elsewhere each stop the sync', async (t) => {
  const dataDir = followerDir(t, 'a'.repeat(64));
  const run = (connection, extra = {}) => withStore(dataDir, (store) => syncGlobalCopy({ dataDir, store, connection, hostSpace: KNOWN,
    ownFormats: FORMATS, localSpaceId: HOST_SPACE_ID, importInto: async () => assert.fail('not imported'), ...extra }));
  assert.equal((await run(scriptedConnection({ digest: { reachable: true, status: 404, text: '{"error":"not_found"}' } }))).outcome,
    'host_cannot_copy');
  assert.match(globalCopyLine({ last: readGlobalCopyRecord(dataDir).last, everyMinutes: 10 }).zh,
    /主机的 FULI 还不能提供副本，升级主机后继续。/);
  assert.equal((await run(scriptedConnection({}), { hostSpace: { known: false, reason: 'host_too_old' } })).outcome, 'host_cannot_copy');

  const away = await run(scriptedConnection({ digest: { reachable: false } }));
  assert.deepEqual([away.outcome, away.reason], ['waiting', 'host_unreachable']);
  assert.match(globalCopyLine({ last: readGlobalCopyRecord(dataDir).last, everyMinutes: 10 }).zh, /上次同步时主机不在线，连上后再同步/);
  const dbDown = await run(scriptedConnection({ digest: { reachable: true, status: 503,
    text: '{"error":"host_provider_unavailable","message":"x"}' } }));
  assert.deepEqual([dbDown.outcome, dbDown.reason], ['waiting', 'host_provider_unavailable']);

  assert.equal((await run(scriptedConnection({}), { localSpaceId: OTHER_SPACE_ID })).outcome, 'space_differs');
  const other = envelopeText('6'.repeat(64), { spaceId: OTHER_SPACE_ID });
  assert.equal((await run(scriptedConnection({ digest: digestAnswer(other) }))).outcome, 'space_differs',
    'the export says the space it is of now');

  const text = envelopeText('7'.repeat(64));
  const release = holdPreparationLock(dataDir, { waitMs: 0 });
  try {
    assert.equal((await run(scriptedConnection({ digest: digestAnswer(text), envelope: envelopeAnswer(text) }))).outcome, 'busy',
      'one import at a time: a preparation holds the lock');
  } finally {
    release();
  }
});

test('the first sync of the preparation runs under the lock it already holds', async (t) => {
  const dataDir = followerDir(t, 'a'.repeat(64));
  const text = envelopeText('8'.repeat(64));
  const release = holdPreparationLock(dataDir, { waitMs: 0 });
  try {
    const imported = [];
    const outcome = await syncFromPreparation({ dataDir, configPath: path.join(dataDir, 'graph-runtime.json'), hostSpace: KNOWN,
      ownFormats: FORMATS, importInto: async (input) => { imported.push(input); return { imported: {} }; },
      withHost: async (_dir, _options, use) => withStore(dataDir, (store) => use({ store,
        connection: scriptedConnection({ digest: digestAnswer(text), envelope: envelopeAnswer(text) }) })) });
    assert.equal(outcome.outcome, 'synced');
    assert.equal(imported[0].owner, 'a'.repeat(64));
  } finally {
    release();
  }
  const failed = await syncFromPreparation({ dataDir, configPath: path.join(dataDir, 'graph-runtime.json'), hostSpace: KNOWN,
    ownFormats: FORMATS, withHost: async () => { throw new Error('synthetic: no identity'); } });
  assert.equal(failed.outcome, 'failed', 'never thrown into the preparation');
});

test('the running sync asks nothing while the runtime does not run, and then every interval', async (t) => {
  const dataDir = followerDir(t, 'a'.repeat(64));
  let clock = 0;
  let healthAsked = 0;
  let running = false;
  const synced = [];
  const connection = { current: null, hello: async () => ({ space: { id: HOST_SPACE_ID, providerId: 'local-personal' },
    formats: { graph: 25, replicaProtocol: 1 } }) };
  const store = new RunnerStore(path.join(dataDir, RUNNER_FILE));
  const loop = startGlobalSync({ dataDir, store, connection, every: 10 * 60_000, tick: 3_600_000, now: () => clock,
    health: async () => { healthAsked += 1; return running ? { ...FORMATS, globalReplica: true } : { unreachable: true }; },
    providerRecorded: () => running, owed: () => null,
    sync: async (input) => { synced.push(input); return { outcome: 'synced' }; } });
  try {
    assert.equal(await loop.round(), null);
    assert.equal(healthAsked, 0, 'the process record names no Provider: not even asked on loopback, nothing started');
    assert.equal(synced.length, 0, 'the host is not asked either');
    running = true;
    assert.deepEqual(await loop.round(), { outcome: 'synced' });
    assert.deepEqual(synced[0].hostSpace, KNOWN);
    assert.deepEqual(synced[0].ownFormats, { ...FORMATS, globalReplica: true });
    assert.equal(synced[0].localSpaceId, HOST_SPACE_ID);
    assert.equal(synced[0].verify, true, 'the first sync of a process imports even an unchanged digest');
    clock = 9 * 60_000;
    assert.equal(await loop.round(), null, 'not due yet');
    clock = 10 * 60_000;
    await loop.round();
    assert.equal(synced.length, 2);
    assert.equal(synced[1].verify, false, 'later ones verify every VERIFY_EVERY-th time');

    clock += 1;
    requestSyncSoon(dataDir, { now: () => clock });
    await loop.round();
    assert.equal(synced.length, 3, 'a delivered write wakes the next round before the normal interval');
    assert.equal(await loop.round(), null, 'the request was answered');

    writeRecord(dataDir, { state: 'ready', createdHere: true, running: false, projects: [], space: { state: 'later', reason: 'host_unreachable' } });
    clock = 30 * 60_000;
    healthAsked = 0;
    assert.equal(await loop.round(), null);
    assert.equal(healthAsked, 0, 'a graph not yet under the host\'s space is not even asked');
  } finally {
    loop.close();
    store.close();
  }
});

test('the state band, /local and fuli status say where the copy stands', async (t) => {
  const dataDir = followerDir(t, 'a'.repeat(64));
  const nowhere = { connect: async () => null, hello: async () => null, drop() {}, close() {}, current: null, pinFailed: false };
  const state = (dir) => withStore(dir, (store) => followerStatus({ store, connection: nowhere, dataDir: dir, reach: false }));
  const never = await state(dataDir);
  assert.equal(never.globalCopy.checkedAt, null);
  assert.match(followerLine(never).zh, /全局副本未同步/);
  assert.match(globalCopyLine(never.globalCopy).zh, /^全局副本（习惯、助手名册）：还没同步过。这台电脑的控制台启动、且主机在线时补上第一份：为此启动一次本机运行时，完成后停掉。$/);

  const text = envelopeText('9'.repeat(64));
  await withStore(dataDir, (store) => syncGlobalCopy({ dataDir, store, hostSpace: KNOWN, ownFormats: FORMATS,
    localSpaceId: HOST_SPACE_ID, connection: scriptedConnection({ digest: digestAnswer(text), envelope: envelopeAnswer(text) }),
    importInto: async () => ({ imported: {} }), now: () => Date.parse('2026-11-24T10:00:00.000Z') }));
  const synced = await state(dataDir);
  assert.equal(synced.globalCopy.syncedAt, '2026-11-24T10:00:00.000Z', 'from the routes store');
  assert.match(followerLine(synced).zh, /全局副本核对于 2026-11-24T10:00:00.000Z/);
  const line = globalCopyLine(synced.globalCopy);
  assert.equal(line.zh, '全局副本（习惯、助手名册）：上次核对 2026-11-24T10:00:00.000Z，内容上次变化于 2026-11-24T10:00:00.000Z。'
    + '本机运行时现在没有运行，下次在它运行时再核对；平时不会为了同步专门启动它，只在 FULI 升级后启动一次。');
  const page = followerConsolePage({ status: { ...synced, host: { ...synced.host, reachable: null } }, hostPath: '/remote/host-a/' });
  assert.ok(page.includes(line.zh), '/local');
  assert.ok(formatFollowerResult('status', { status: 'running', url: 'http://127.0.0.1:2727', ...synced, line: followerLine(synced) })
    .includes(line.en), 'fuli status');

  writeRecord(dataDir, { state: 'ready', createdHere: true, running: true, projects: [], space: { state: 'same', id: HOST_SPACE_ID } });
  assert.match(globalCopyLine((await state(dataDir)).globalCopy).zh, /本机运行时在运行：每 10 分钟问一次主机，有变化才取。/);
});

test('leaving sets the graph that holds the host\'s copy aside, never deletes it, and leaves one without a copy alone', async (t) => {
  const dataDir = followerDir(t, 'a'.repeat(64));
  const paths = resolveSetupPaths({ dataDir, env: {} });
  const steps = [];
  const fakes = { stop: async () => { steps.push('stop'); },
    setAside: async (_paths, _at, note) => { steps.push(note.kind); return { folder: path.join(dataDir, 'native-runtime', 'recovered', 'x') }; } };
  assert.equal(await setAsideHostCopy(paths, fakes), null, 'no copy arrived: nothing moves');
  assert.deepEqual(steps, []);

  const text = envelopeText('a'.repeat(64));
  await withStore(dataDir, (store) => syncGlobalCopy({ dataDir, store, hostSpace: KNOWN, ownFormats: FORMATS,
    localSpaceId: HOST_SPACE_ID, connection: scriptedConnection({ digest: digestAnswer(text), envelope: envelopeAnswer(text) }),
    importInto: async () => ({ imported: {} }) }));
  const release = holdPreparationLock(dataDir, { waitMs: 0 });
  try {
    await assert.rejects(setAsideHostCopy(paths, fakes), { code: 'local_runtime_preparing' });
    assert.deepEqual(steps, [], 'nothing moved while the runtime is held');
  } finally {
    release();
  }
  assert.deepEqual(await setAsideHostCopy(paths, fakes), { folder: path.join(dataDir, 'native-runtime', 'recovered', 'x') });
  assert.deepEqual(steps, ['stop', 'follower-host-copy']);
  assert.equal(existsSync(path.join(dataDir, COPY_FILE)), false);

  // `fuli runner leave`: the set-aside comes first; when it cannot, the pairing stays.
  const said = [];
  const refused = await runRunnerCommand(['leave', '--data-dir', dataDir], { env: {}, write: (line) => said.push(line),
    setAsideCopy: async () => { throw Object.assign(new Error('synthetic: busy.'), { code: 'local_runtime_preparing' }); } });
  assert.equal(refused.exitCode, 1);
  assert.match(said.join('\n'), /Nothing was changed; this computer still follows Host A\./);
  assert.ok(existsSync(path.join(dataDir, RUNNER_FILE)));
  said.length = 0;
  const left = await runRunnerCommand(['leave', '--data-dir', dataDir], { env: {}, write: (line) => said.push(line),
    setAsideCopy: async () => ({ folder: 'native-runtime/recovered/synthetic' }) });
  assert.equal(left.exitCode, 0);
  assert.match(said.join('\n'), /held only Host A's copy of global; it was set aside, not deleted, in native-runtime\/recovered\/synthetic\./);
  assert.equal(existsSync(path.join(dataDir, RUNNER_FILE)), false, 'then the pairing ends');
});

test('a verifying sync imports an unchanged digest and says when it found the copy changed here', async (t) => {
  const dataDir = followerDir(t, 'a'.repeat(64));
  const text = envelopeText('1'.repeat(64));
  let clock = Date.parse('2026-11-24T09:00:00.000Z');
  let wrote = { nodes: { created: 1 } };
  const imported = [];
  const importInto = async (input) => { imported.push(input); return { imported: wrote }; };
  const sync = (verify) => withStore(dataDir, (store) => syncGlobalCopy({ dataDir, store, hostSpace: KNOWN, ownFormats: FORMATS,
    localSpaceId: HOST_SPACE_ID, connection: scriptedConnection({ digest: digestAnswer(text), envelope: envelopeAnswer(text) }),
    importInto, now: () => clock, verify }));
  await sync(false);
  clock += 10 * 60_000;
  // Something else wrote this computer's graph: the import writes the host's records back.
  wrote = { nodes: { created: 0, updated: 1, unchanged: 40, deleted: 0 }, relationships: { created: 0, updated: 0, deleted: 0 } };
  const corrected = await sync(true);
  assert.equal(imported.length, 2, 'imported although the digest is the one recorded');
  assert.equal(corrected.corrected, true);
  assert.equal(readGlobalCopyRecord(dataDir).changedAt, '2026-11-24T09:10:00.000Z');
  clock += 10 * 60_000;
  wrote = { nodes: { created: 0, updated: 0, unchanged: 41, deleted: 0 }, relationships: { created: 0, updated: 0, deleted: 0 } };
  const same = await sync(true);
  assert.equal(same.unchanged, true);
  assert.equal(readGlobalCopyRecord(dataDir).changedAt, '2026-11-24T09:10:00.000Z', 'nothing written: not a change');
  assert.equal(readGlobalCopyRecord(dataDir).checkedAt, '2026-11-24T09:20:00.000Z');
});

test('the copy is said to have arrived before the import writes, so a process ended after it is still known', async (t) => {
  const dataDir = followerDir(t, 'a'.repeat(64));
  const text = envelopeText('1'.repeat(64));
  const replicaNow = () => { const routes = openRoutes(dataDir); try { return routes.hasReplica(GLOBAL_SCOPE); } finally { routes.close(); } };
  let seenDuringImport = null;
  await assert.rejects(withStore(dataDir, (store) => syncGlobalCopy({ dataDir, store, hostSpace: KNOWN, ownFormats: FORMATS,
    localSpaceId: HOST_SPACE_ID, connection: scriptedConnection({ digest: digestAnswer(text), envelope: envelopeAnswer(text) }),
    importInto: async () => { seenDuringImport = replicaNow(); throw new Error('synthetic: the process ended here'); } })));
  assert.equal(seenDuringImport, true);
  assert.equal(replicaNow(), true, '`fuli runner leave` sets this graph aside');
  assert.equal(readGlobalCopyRecord(dataDir).digest, undefined, 'never recorded as synced');
});

test('a refused digest (413, 409) is not asked again in the same situation for a day', async (t) => {
  const dataDir = followerDir(t, 'a'.repeat(64));
  let clock = Date.parse('2026-11-24T09:00:00.000Z');
  const tooLarge = { reachable: true, status: 413, text: JSON.stringify({ error: 'scope_too_large', bytes: 70_000_000, max: 67_108_864 }) };
  const sync = (connection, hostSpace = KNOWN) => withStore(dataDir, (store) => syncGlobalCopy({ dataDir, store, hostSpace,
    ownFormats: FORMATS, localSpaceId: HOST_SPACE_ID, connection, importInto: async () => assert.fail('nothing imported'), now: () => clock }));
  const first = scriptedConnection({ digest: tooLarge });
  assert.equal((await sync(first)).code, 'scope_too_large');
  assert.equal(readGlobalCopyRecord(dataDir).last.phase, 'digest');
  clock += 10 * 60_000;
  const again = scriptedConnection({ digest: () => assert.fail('not asked again') });
  assert.equal((await sync(again)).repeated, true);
  assert.deepEqual(again.asked, []);
  const newer = scriptedConnection({ digest: tooLarge });
  await sync(newer, { ...KNOWN, graphFormat: 25, replicaProtocol: 2 });
  assert.deepEqual(newer.asked, [], 'another version stops before the digest (versions differ)');
  clock += DIGEST_REFUSAL_AGAIN_MS;
  const later = scriptedConnection({ digest: tooLarge });
  await sync(later);
  assert.deepEqual(later.asked, ['digest'], 'asked again after a day: the host\'s content may have changed');
});

test('a host never keeps an export past the size cap, and answers the next asks without exporting again', async () => {
  let exports = 0;
  const asked = [];
  const scope = createScopeExport({ app: hostApp(async (input) => { exports += 1; asked.push(input);
    throw Object.assign(new Error('larger than the cap'), { status: 413, code: 'scope_too_large' }); }), maxBytes: 100 });
  const answer = await scope.answer('global', 'digest');
  assert.equal(answer.status, 413);
  assert.equal(answer.body.error, 'scope_too_large');
  assert.equal(asked[0].maxBytes, 100, 'the Provider\'s export is read up to the cap only');
  await scope.answer('global', 'envelope');
  assert.equal(exports, 1);
});

test('leaving refuses to move a graph whole that holds data of this computer\'s own', async (t) => {
  const dataDir = followerDir(t, 'a'.repeat(64));
  const paths = resolveSetupPaths({ dataDir, env: {} });
  const routes = openRoutes(dataDir);
  try { routes.replicaSynced(GLOBAL_SCOPE, '2026-11-24T09:00:00.000Z'); } finally { routes.close(); }
  const fakes = { stop: async () => assert.fail('nothing stopped'), setAside: async () => assert.fail('nothing moved') };
  const own = (found) => ({ ...fakes, ownData: async () => found });
  await assert.rejects(setAsideHostCopy(paths, own('1 project(s)')), { code: 'local_data_here' });

  const unanswered = async () => ({ unreachable: true });
  await assert.rejects(ownDataHere(paths, { localRoutes: ['project:synthetic'], projects: unanswered }),
    { code: 'own_data_unknown' });
  assert.equal(await ownDataHere(paths, { projects: async () => ({ projects: ['synthetic-project'] }),
    ownGlobal: async () => ({ count: 0 }) }), '1 project(s)');
  assert.equal(await ownDataHere(paths, { projects: async () => ({ projects: [] }), ownGlobal: async () => ({ count: 3 }) }),
    '3 record(s) of global');
  assert.equal(await ownDataHere(paths, { projects: unanswered, ownGlobal: unanswered,
    record: () => ({ projects: [], ownGlobal: 2 }) }), '2 record(s) of global', 'not running: what the preparation found');
  assert.equal(await ownDataHere(paths, { projects: unanswered, ownGlobal: unanswered, record: () => ({ projects: [] }) }), null);
});

test('a project owner compares replica content with its last import before fetching an unchanged envelope', async (t) => {
  const dataDir = followerDir(t, 'a'.repeat(64));
  const text = envelopeText('a'.repeat(64));
  let content = 'original';
  let imports = 0;
  let checks = 0;
  const sync = () => withStore(dataDir, store => syncGlobalCopy({ dataDir, store, hostSpace: KNOWN, ownFormats: FORMATS,
    localSpaceId: HOST_SPACE_ID, connection: scriptedConnection({ digest: digestAnswer(text), envelope: envelopeAnswer(text) }),
    replicaSummary: async () => { checks++; return { contentDigest: content }; },
    importInto: async () => { imports++; return { imported: { contentDigest: 'original', nodes: { updated: 1 } } }; } }));
  await sync();
  assert.equal(checks, 0);
  assert.equal((await sync()).unchanged, true);
  assert.equal(imports, 1);
  content = 'changed locally';
  assert.equal((await sync()).corrected, true);
  assert.equal(imports, 2);
  assert.equal(checks, 2);
});

test('a project owner reads its copy’s content summary only on a verifying round or after an import that did not finish', async (t) => {
  const dataDir = followerDir(t, 'a'.repeat(64));
  let clock = 0;
  const synced = [];
  const leased = [];
  const connection = { current: null, hello: async () => ({ space: { id: HOST_SPACE_ID, providerId: 'local-personal' },
    formats: { graph: 25, replicaProtocol: 1 } }) };
  const store = new RunnerStore(path.join(dataDir, RUNNER_FILE));
  let outcome = { outcome: 'synced' };
  const loop = startGlobalSync({ dataDir, store, connection, every: 10 * 60_000, tick: 3_600_000, now: () => clock,
    health: async () => ({ ...FORMATS, globalReplica: true }), providerRecorded: () => true, owed: () => assert.fail('nothing owed'),
    prepare: () => assert.fail('nothing started beside the broker'), owns: () => true, deliver: async () => ({}),
    lease: async action => { leased.push(clock); return action(); },
    sync: async (input) => { synced.push(input); return outcome; } });
  try {
    for (let round = 0; round < 7; round += 1) {
      clock = round * 10 * 60_000;
      await loop.round();
    }
    assert.deepEqual(synced.map(input => Boolean(input.replicaSummary)), [true, false, false, false, false, false, true],
      'every VERIFY_EVERY-th round only');
    assert.equal(leased.length, 7, 'each round inside the broker’s lease');
    recordGlobalCopy(dataDir, { last: { at: '2026-11-24T09:00:00.000Z', outcome: 'waiting', reason: IMPORT_UNFINISHED } });
    clock += 10 * 60_000;
    await loop.round();
    assert.equal(Boolean(synced.at(-1).replicaSummary), true, 'after an import that did not finish');
    recordGlobalCopy(dataDir, { last: { at: '2026-11-24T09:10:00.000Z', outcome: 'synced' } });
    clock += 10 * 60_000;
    await loop.round();
    assert.equal(Boolean(synced.at(-1).replicaSummary), false);
  } finally {
    loop.close();
    store.close();
  }
});

test('a project owner’s sync waits for its broker: a sleeping runtime is not started for it', async (t) => {
  const dataDir = followerDir(t, 'a'.repeat(64));
  const synced = [];
  const store = new RunnerStore(path.join(dataDir, RUNNER_FILE));
  const loop = startGlobalSync({ dataDir, store, connection: { current: null, hello: async () => null }, tick: 3_600_000,
    health: async () => ({ unreachable: true }), providerRecorded: () => true, owns: () => true,
    owed: () => assert.fail('a copy owed is the broker’s'), prepare: () => assert.fail('nothing started beside the broker'),
    lease: async () => null, sync: async (input) => { synced.push(input); return { outcome: 'synced' }; } });
  try {
    assert.equal(await loop.round(), null);
    assert.equal(synced.length, 0);
  } finally {
    loop.close();
    store.close();
  }
});

test('leaving with projects here names the recruitments still waiting for the host only when there are some', async (t) => {
  for (const [waiting, said] of [[0, null], [3, /3 recruitment\(s\) were waiting for the former host .*cancel them/],
    [null, /could not be counted/]]) {
    const dataDir = followerDir(t, 'a'.repeat(64));
    const lines = [];
    const left = await runRunnerCommand(['leave', '--data-dir', dataDir], { env: {}, write: (line) => lines.push(line),
      setAsideCopy: async (_paths, { finish }) => { finish(true); return { folder: 'synthetic-copy', released: true, waitingRecruitments: waiting }; } });
    const text = lines.join('\n');
    assert.equal(left.exitCode, 0, text);
    assert.match(text, /The host replica was released\. Local projects remain here\./);
    if (said) assert.match(text, said, String(waiting));
    else assert.doesNotMatch(text, /recruitment/i, 'none waiting: not mentioned');
  }
});
