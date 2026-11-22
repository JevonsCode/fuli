import assert from 'node:assert/strict';
import { connect as connectTcp } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createDeviceCertificate, deviceIdentity } from '../packages/roundtable/src/peer/device-identity.js';
import { runRunnerCommand } from '../src/cli/runner-command.js';
import { recentNotices } from '../src/notices/recent-notices.js';
import { createHostConnection } from '../src/runner/host-connection.js';
import { startRunnerListener } from '../src/runner/host-listener.js';
import { RunnerHostStore } from '../src/runner/host-store.js';
import { offlineAnswer } from '../src/runner/offline-calls.js';
import { deliverOutbox } from '../src/runner/outbox-delivery.js';
import { joinHost } from '../src/runner/join.js';
import { encodeInvitation, newInvitationCode, RUNNER_PATHS } from '../src/runner/protocol.js';
import { projectIdentityCache } from '../src/system/project-identity-cache.js';
import { RUNNER_FILE, RunnerStore } from '../src/runner/runner-store.js';

const HOST = { name: 'Host A', fingerprint: 'f'.repeat(64), certPem: 'synthetic', port: 2730, addresses: ['192.168.1.20'] };
const DAY_MS = 24 * 60 * 60 * 1000;
const text = (result) => JSON.parse(result.content[0].text);
const count = (store, table) => store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;

function pairedRunner({ now = Date.now } = {}) {
  const store = new RunnerStore(':memory:', { now });
  store.saveHost(HOST);
  return store;
}

function keptSomething(store) {
  store.rememberAnswer('read:search:1', 'search_knowledge_graph', { content: [{ type: 'text', text: '{"hits":[]}' }] });
  offlineAnswer(store, { tool: 'begin_task_context', input: { projectPath: '/synthetic/repo' }, sourceApplication: 'codex' });
  offlineAnswer(store, { tool: 'checkpoint_task_knowledge', input: { retain_nothing: true }, sourceApplication: 'codex' });
}

test('an online checkpoint whose outcome is unknown is queued under the id it carried', () => {
  const store = pairedRunner();
  const answer = offlineAnswer(store, { tool: 'checkpoint_task_knowledge', input: { taskContextToken: 'host-token' },
    sourceApplication: 'codex', sessionId: 'session-1', entryId: 'online-entry-1' });
  assert.equal(answer.structuredContent.outboxId, 'online-entry-1');
  assert.equal(store.claimNext().id, 'online-entry-1');
});

test('the outbox goes oldest first: while one process holds the oldest entry, no other entry is handed out', () => {
  const store = pairedRunner();
  store.enqueue({ id: 'first', tool: 'checkpoint_task_knowledge', input: {}, sourceApplication: 'codex' });
  store.enqueue({ id: 'second', tool: 'checkpoint_task_knowledge', input: {}, sourceApplication: 'codex' });
  assert.equal(store.claimNext().id, 'first');
  assert.equal(store.claimNext(), null);
  store.release('first', 'host_unreachable');
  assert.equal(store.claimNext().id, 'first');
});

test('an entry the host is still applying waits for the next round', async () => {
  const store = pairedRunner();
  store.enqueue({ id: 'pending-entry', tool: 'checkpoint_task_knowledge', input: {}, sourceApplication: 'codex' });
  const connection = { postJson: async () => ({ reachable: true, status: 409, body: { error: 'replay_pending' } }) };
  const round = await deliverOutbox({ store, connection });
  assert.deepEqual([round.delivered, round.refused, round.queued], [0, 0, 1]);
  assert.equal(store.db.prepare("SELECT last_error FROM outbox").get().last_error, "replay_pending");
});

test('a host that revoked the runner ends what was read from it; waiting checkpoints stay refused, are not retried, and it says to join again', () => {
  const store = pairedRunner();
  keptSomething(store);
  store.revoked();
  assert.deepEqual(['answers', 'offline_tasks'].map((table) => count(store, table)), [0, 0]);
  assert.deepEqual(store.db.prepare('SELECT state, last_error FROM outbox').all().map((row) => ({ ...row })),
    [{ state: 'failed', last_error: 'runner_revoked' }]);
  assert.equal(store.claimNext(), null, 'a refused checkpoint is not delivered again');
  const answer = offlineAnswer(store, { tool: 'search_knowledge_graph', input: {}, sourceApplication: 'codex' });
  assert.equal(answer.isError, true);
  assert.equal(text(answer).code, 'runner_revoked');
  assert.match(text(answer).message, /revoked.*not known there.*fuli runner join/s);
  assert.equal(text(offlineAnswer(new RunnerStore(':memory:'), { tool: 'search_knowledge_graph', input: {},
    sourceApplication: 'codex' })).code, 'runner_not_paired');
});

test('answers past their keeping time are deleted when the next one is written', () => {
  let now = Date.parse('2026-11-01T00:00:00Z');
  const store = pairedRunner({ now: () => now });
  store.rememberAnswer('read:old', 'search_knowledge_graph', { content: [] });
  now += 31 * DAY_MS;
  store.rememberAnswer('read:new', 'search_knowledge_graph', { content: [] });
  assert.deepEqual(store.db.prepare('SELECT key FROM answers').all().map((row) => row.key), ['read:new']);
});

test('joining the same host again queues its refused checkpoints again; joining another host drops them and says how many', () => {
  const store = pairedRunner();
  keptSomething(store);
  assert.deepEqual(store.saveHost({ ...HOST, addresses: ['192.168.1.21'] }), { dropped: 0, requeued: 0 });
  assert.deepEqual(['answers', 'offline_tasks', 'outbox'].map((table) => count(store, table)), [1, 1, 1]);
  store.revoked();
  assert.deepEqual(store.saveHost(HOST), { dropped: 0, requeued: 1 });
  assert.equal(store.host().revokedAt, null, 'a new pairing is not revoked');
  assert.equal(store.outbox().queued, 1, 'queued again, so the next delivery sends it');
  keptSomething(store);
  assert.deepEqual(store.saveHost({ ...HOST, fingerprint: 'e'.repeat(64) }), { dropped: 2, requeued: 0 });
  assert.deepEqual(['answers', 'offline_tasks', 'outbox'].map((table) => count(store, table)), [0, 0, 0]);
});

test('a delivered checkpoint is deleted at once; a refused one after 30 days', () => {
  let now = Date.parse('2026-11-01T00:00:00Z');
  const store = pairedRunner({ now: () => now });
  for (const id of ['delivered', 'refused', 'later']) store.enqueue({ id, tool: 'checkpoint_task_knowledge', input: {}, sourceApplication: 'codex' });
  store.delivered('delivered');
  store.failed('refused', 'invalid_input');
  assert.deepEqual([store.entryState('delivered'), store.entryState('refused')], [null, 'failed']);
  now += 31 * DAY_MS;
  store.failed('later', 'invalid_input');
  assert.deepEqual(store.db.prepare('SELECT id FROM outbox').all().map((row) => row.id), ['later']);
});

test('joining prints how many checkpoints of the previous host were dropped', async (t) => {
  const dataDir = dataDirectory(t);
  const lines = [];
  await runRunnerCommand(['join', 'synthetic-invitation', '--data-dir', dataDir], { write: (line) => lines.push(line),
    join: async () => ({ host: { name: 'Host B', address: '192.168.1.20', port: 2730 }, runner: { fingerprint: 'c'.repeat(64) },
      outbox: { dropped: 3, requeued: 0 } }),
    setupClients: async () => [{ id: 'codex', status: 'connected' }] });
  assert.match(lines.join('\n'), /3 checkpoint\(s\) kept for the previous host were dropped/);
});

function dataDirectory(t) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'fuli-runner-life-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

test('fuli runner leave ends the pairing and deletes what is kept here, with --force when checkpoints still wait', async (t) => {
  const dataDir = dataDirectory(t);
  mkdirSync(path.join(dataDir, 'runner'));
  const store = new RunnerStore(path.join(dataDir, RUNNER_FILE));
  store.saveHost(HOST);
  keptSomething(store);
  store.close();
  // The host's answers about its projects go with the rest of what it gave (rec#145).
  projectIdentityCache(dataDir).remember('/work/blue-kettle', { space: { id: 'space-7f3' } });
  const refusedLines = [];
  const refused = await runRunnerCommand(['leave', '--data-dir', dataDir], { write: (line) => refusedLines.push(line) });
  assert.equal(refused.exitCode, 1);
  assert.match(refusedLines.join('\n'), /1 outbox entries \(checkpoints, executor decisions\) still wait for Host A and 0 were refused by it; .*--force/);
  assert.equal(existsSync(path.join(dataDir, RUNNER_FILE)), true);
  const lines = [];

  const result = await runRunnerCommand(['leave', '--force', '--data-dir', dataDir], { write: (line) => lines.push(line) });

  assert.equal(result.exitCode, 0);
  assert.match(lines.join('\n'), /keep their FULI MCP entry.*`fuli uninstall` removes those entries/s);
  assert.equal(existsSync(path.join(dataDir, RUNNER_FILE)), false);
  assert.equal(projectIdentityCache(dataDir).last('/work/blue-kettle'), null);
  assert.match(lines.join('\n'), /Left Host A\. The pairing, the answers kept here, the outbox and the executor decisions made here are deleted\./);
  assert.match(lines.join('\n'), /fuli runner revoke [0-9a-f]{16}/);
  const usage = [];
  await runRunnerCommand(['--help'], { write: (line) => usage.push(line) });
  assert.match(usage.join('\n'), /leave \[--force\] +end the pairing here/);
});

test('joining says what the runner keeps and for how long', async (t) => {
  const dataDir = dataDirectory(t);
  const lines = [];
  await runRunnerCommand(['join', 'synthetic-invitation', '--data-dir', dataDir], { write: (line) => lines.push(line),
    join: async () => ({ host: { name: 'Host A', address: '192.168.1.20', port: 2730 }, runner: { fingerprint: 'c'.repeat(64) } }),
    setupClients: async () => [{ id: 'codex', status: 'connected' }] });
  const said = lines.join('\n');
  assert.doesNotMatch(said, /nothing of FULI's knowledge is kept here/);
  assert.match(said, /Kept here: the host's last answers .* deleted after 30 days\) and checkpoints waiting for the host \(deleted once delivered; refused ones after 30 days\)/);
  assert.match(said, /checkpoints wait, refused, until it joins the same host again/);
});

test('a pairing keeps the name the person typed, shows the device\'s own beside it, and is a notice on the host', async () => {
  const store = new RunnerHostStore(':memory:');
  store.invite({ code: 'synthetic-invitation-code-1', name: 'Office laptop' });
  const runner = store.pair({ code: 'synthetic-invitation-code-1', fingerprint: 'a'.repeat(64), deviceName: 'DESKTOP-SYNTH' });
  assert.deepEqual([runner.name, runner.deviceName], ['Office laptop', 'DESKTOP-SYNTH']);
  const app = { config: { personal: { spaceId: 'space' } }, listPersonalProjects: async () => [],
    listProjectAgents: async () => [], runnerHost: { list: () => ({ runners: store.runners() }) } };

  const { items } = await recentNotices({ app, query: { kinds: ['runner_paired'] } });

  assert.equal(items.length, 1);
  assert.deepEqual(items[0].params, { name: 'Office laptop', device: 'DESKTOP-SYNTH', fingerprint: 'a'.repeat(16) });
  store.revoke('a'.repeat(64));
  assert.equal((await recentNotices({ app, query: { kinds: ['runner_paired'] } })).items.length, 0);
});

async function tlsPair(t, route) {
  const [host, runner] = await Promise.all([createDeviceCertificate(), createDeviceCertificate()]).then((pair) => pair.map(deviceIdentity));
  const listener = await startRunnerListener({ identity: host, addresses: ['127.0.0.1'], port: 0, route, sourceAllowed: () => true });
  t.after(() => listener.close());
  const store = new RunnerStore(':memory:');
  store.saveHost({ name: 'Host A', fingerprint: host.fingerprint, certPem: host.certPem, port: listener.port, addresses: ['127.0.0.1'] });
  const connection = createHostConnection({ store, identity: runner, lookUp: async () => [], bindAddresses: () => [] });
  t.after(() => connection.close());
  return { store, connection, listener };
}

test('a host answering that it does not know the runner revokes it here, and nothing is looked for again', async (t) => {
  let hellos = 0;
  const { store, connection } = await tlsPair(t, async (_request, response, { pathname }) => {
    if (pathname === RUNNER_PATHS.hello) hellos += 1;
    response.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'runner_unknown' }));
    return true;
  });
  keptSomething(store);

  assert.equal(await connection.connect(), null);
  assert.ok(store.host().revokedAt);
  assert.equal(store.outbox().queued, 0);
  assert.equal(await connection.connect(), null);
  assert.equal(hellos, 1);
});

test('a replay that timed out is not sent again in the same delivery', async (t) => {
  const replays = [];
  const { connection } = await tlsPair(t, async (request, response, { pathname }) => {
    if (pathname === RUNNER_PATHS.hello) {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      return true;
    }
    replays.push(pathname);
    request.resume();
    request.on('end', () => setTimeout(() => response.writeHead(200).end('{}'), 1500).unref());
    return true;
  });

  const answer = await connection.postJson(RUNNER_PATHS.replay, { id: 'slow' }, { timeoutMs: 200 });

  assert.deepEqual(answer, { reachable: false, timedOut: true });
  assert.deepEqual(replays, [RUNNER_PATHS.replay]);
});

test('one address may hold more connections than it once could: a runner\'s MCP processes are not capped per address', async (t) => {
  const identity = deviceIdentity(await createDeviceCertificate());
  const listener = await startRunnerListener({ identity, addresses: ['127.0.0.1'], port: 0, sourceAllowed: () => true,
    route: async () => false });
  const sockets = [];
  t.after(async () => { for (const socket of sockets) socket.destroy(); await listener.close(); });
  const open = () => new Promise((resolve) => {
    const socket = connectTcp(listener.port, '127.0.0.1');
    sockets.push(socket);
    socket.on('error', () => {});
    socket.once('connect', () => resolve(socket));
  });
  // Past the 24 one address was held to before.
  for (let index = 0; index < 40; index += 1) await open();
  await delay(200);
  assert.equal(sockets.filter((socket) => socket.destroyed).length, 0);
});

test('closing the connection cuts a replay waiting on the host at once, and its entry stays queued', async (t) => {
  const { store, connection } = await tlsPair(t, async (request, response, { pathname }) => {
    if (pathname === RUNNER_PATHS.hello) {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      return true;
    }
    request.resume();
    response.on('close', () => {});
    return true;
  });
  store.enqueue({ id: 'long-wait', tool: 'checkpoint_task_knowledge', input: {}, sourceApplication: 'codex' });
  const started = Date.now();
  const round = deliverOutbox({ store, connection });
  setTimeout(() => connection.close(), 300).unref();
  const result = await round;
  assert.ok(Date.now() - started < 30_000, 'the 3-minute replay wait was cut by close');
  assert.equal(result.queued, 1);
  assert.equal(store.claimNext().id, 'long-wait');
});

test('joining another host while checkpoints wait for the current one needs --force, and spends no invitation without it', async (t) => {
  const dataDir = dataDirectory(t);
  mkdirSync(path.join(dataDir, 'runner'));
  const store = new RunnerStore(path.join(dataDir, RUNNER_FILE));
  store.saveHost(HOST);
  keptSomething(store);
  store.close();
  const other = deviceIdentity(await createDeviceCertificate());
  // An address nothing listens on: refused before any request is sent.
  const invitation = encodeInvitation({ name: 'Host B', addresses: ['192.0.2.1'], port: 2730, certPem: other.certPem,
    code: newInvitationCode() });
  let loaded = false;

  await assert.rejects(joinHost({ dataDir, invitation, loadIdentity: async () => { loaded = true; return other; } }),
    { code: 'runner_checkpoints_waiting', message: /1 checkpoint\(s\) still wait for Host A .*--force\. The invitation was not used\./ });
  assert.equal(loaded, false, 'nothing was sent to the other host');
});

test('refused checkpoints past 30 days go when the runner is revoked and when its MCP process starts', () => {
  let now = Date.parse('2026-11-01T00:00:00Z');
  const store = pairedRunner({ now: () => now });
  for (const id of ['old-1', 'old-2']) {
    store.enqueue({ id, tool: 'checkpoint_task_knowledge', input: {}, sourceApplication: 'codex' });
    store.failed(id, 'invalid_input');
  }
  now += 31 * DAY_MS;
  store.enqueue({ id: 'waiting', tool: 'checkpoint_task_knowledge', input: {}, sourceApplication: 'codex' });
  store.pruneRefused();
  assert.deepEqual(store.db.prepare('SELECT id FROM outbox').all().map((row) => row.id), ['waiting']);
  store.enqueue({ id: 'old-3', tool: 'checkpoint_task_knowledge', input: {}, sourceApplication: 'codex' });
  store.db.prepare(`UPDATE outbox SET state = 'failed', settled_at = '2026-10-01T00:00:00.000Z' WHERE id = 'old-3'`).run();
  store.revoked();
  assert.deepEqual(store.db.prepare('SELECT id, last_error FROM outbox').all().map((row) => [row.id, row.last_error]),
    [['waiting', 'runner_revoked']]);
});
