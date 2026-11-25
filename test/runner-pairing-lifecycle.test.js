import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDeviceCertificate, deviceIdentity } from '../packages/roundtable/src/peer/device-identity.js';
import { runRunnerCommand } from '../src/cli/runner-command.js';
import { recentNotices } from '../src/notices/recent-notices.js';
import { createHostConnection } from '../src/runner/host-connection.js';
import { startRunnerListener } from '../src/runner/host-listener.js';
import { RunnerHostStore } from '../src/runner/host-store.js';
import { offlineAnswer, rememberAnswer } from '../src/runner/offline-calls.js';
import { keepWholeEntry } from '../src/runner/entry-whole-read.js';
import { OMITTED_UNREADABLE_LABEL } from '../src/conversations/entry-inline-budget.js';
import { deliverOutbox } from '../src/runner/outbox-delivery.js';
import { joinHost } from '../src/runner/join.js';
import { encodeInvitation, newInvitationCode, RUNNER_PATHS } from '../src/runner/protocol.js';
import { projectIdentityCache } from '../src/system/project-identity-cache.js';
import { isRunnerDataDirectory } from '../src/runner/runner-mode.js';
import { ANSWERS_KEPT, OFFLINE_TOKEN_DAYS, RUNNER_FILE, RunnerStore } from '../src/runner/runner-store.js';

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

// rec#144, Jevons: 「保留 30 天这个没必要，就放着就可以」.
test('no answer kept here is deleted because it is old; a later answer replaces the one it repeats', () => {
  let now = Date.parse('2026-11-01T00:00:00Z');
  const store = pairedRunner({ now: () => now });
  store.rememberAnswer('read:old', 'search_knowledge_graph', { content: [] });
  now += 400 * DAY_MS;
  store.rememberAnswer('read:new', 'search_knowledge_graph', { content: [] });
  store.rememberAnswer('read:old', 'search_knowledge_graph', { content: [{ type: 'text', text: 'newer' }] });
  assert.deepEqual(store.db.prepare('SELECT key FROM answers ORDER BY key').all().map((row) => row.key),
    ['read:new', 'read:old']);
  assert.deepEqual(store.answer('read:old').body.content, [{ type: 'text', text: 'newer' }]);
});

// Review of #1069: no age limit, but a size; past it, what was used longest ago goes first.
test('the cache keeps within its size by letting go of the answers used longest ago', () => {
  let now = Date.parse('2026-11-01T00:00:00Z');
  const store = pairedRunner({ now: () => now });
  for (let index = 0; index < ANSWERS_KEPT; index += 1) {
    store.db.prepare('INSERT INTO answers(key, tool, at, body, used_at) VALUES(?, ?, ?, ?, ?)')
      .run(`read:${index}`, 'search_knowledge_graph', '2026-10-01T00:00:00.000Z', '{}', '2026-10-01T00:00:00.000Z');
  }
  now += DAY_MS;
  assert.ok(store.answer('read:0'), 'read:0 is used, so it is the newest in use');
  now += DAY_MS;
  store.rememberAnswer('read:fresh', 'search_knowledge_graph', { content: [] });
  assert.equal(store.answerUsage().count, ANSWERS_KEPT);
  assert.ok(store.answer('read:0'), 'what was used lately stays, however old it is');
  assert.equal(store.answer('read:1'), null, 'what was used longest ago went');
  assert.ok(store.answer('read:fresh'));
});

test('an offline task token lasts 30 days from its last use; a checkpoint queued under it keeps its folder', () => {
  let now = Date.parse('2026-11-01T00:00:00Z');
  const store = pairedRunner({ now: () => now });
  store.beginOfflineTask({ token: 'runner-offline-synthetic', projectPath: '/synthetic', sourceApplication: 'codex' });
  store.enqueue({ id: 'queued-under-it', tool: 'checkpoint_task_knowledge', input: { taskContextToken: 'runner-offline-synthetic' },
    sourceApplication: 'codex', offlineProjectPath: '/synthetic' });
  now += (OFFLINE_TOKEN_DAYS - 1) * DAY_MS;
  assert.equal(store.offlineTask('runner-offline-synthetic')?.projectPath, '/synthetic', 'used: its days start again');
  now += (OFFLINE_TOKEN_DAYS - 1) * DAY_MS;
  assert.ok(store.offlineTask('runner-offline-synthetic'), 'still in use, though its task began long ago');
  now += (OFFLINE_TOKEN_DAYS + 1) * DAY_MS;
  assert.equal(store.offlineTask('runner-offline-synthetic'), null);
  assert.equal(store.claimNext().offlineProjectPath, '/synthetic', 'the checkpoint queued while it was valid goes as before');
});

// Review of #1069: a checkpoint under an expired offline token was queued and only refused by the host later.
test('a checkpoint under an offline token that is no longer valid is refused before it is queued', () => {
  let now = Date.parse('2026-11-01T00:00:00Z');
  const store = pairedRunner({ now: () => now });
  store.beginOfflineTask({ token: 'runner-offline-synthetic', projectPath: '/synthetic', sourceApplication: 'codex' });
  now += (OFFLINE_TOKEN_DAYS + 1) * DAY_MS;
  const answer = offlineAnswer(store, { tool: 'checkpoint_task_knowledge', sourceApplication: 'codex',
    input: { taskContextToken: 'runner-offline-synthetic', workLog: 'synthetic' } });
  assert.equal(text(answer).code, 'offline_task_expired');
  assert.match(text(answer).message, /get_collaboration_preferences/);
  assert.equal(store.outbox().queued, 0, 'nothing was queued');
  const unknown = offlineAnswer(store, { tool: 'checkpoint_task_knowledge', sourceApplication: 'codex',
    input: { taskContextToken: 'runner-offline-never-given-here' } });
  assert.equal(text(unknown).code, 'offline_task_expired');
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

test('a delivered checkpoint is deleted at once; a refused one stays listed however long it waits', () => {
  let now = Date.parse('2026-11-01T00:00:00Z');
  const store = pairedRunner({ now: () => now });
  for (const id of ['delivered', 'refused', 'later']) store.enqueue({ id, tool: 'checkpoint_task_knowledge', input: {}, sourceApplication: 'codex' });
  store.delivered('delivered');
  store.failed('refused', 'invalid_input');
  assert.deepEqual([store.entryState('delivered'), store.entryState('refused')], [null, 'failed']);
  now += 400 * DAY_MS;
  store.failed('later', 'invalid_input');
  assert.deepEqual(store.db.prepare('SELECT id FROM outbox ORDER BY seq').all().map((row) => row.id), ['refused', 'later']);
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
  assert.match(lines.join('\n'), /Left Host A\. The pairing, the answers kept here, the outbox, the executor decisions made here and the routes to it are deleted\./);
  assert.match(lines.join('\n'), /fuli runner revoke [0-9a-f]{16}/);
  const usage = [];
  await runRunnerCommand(['--help'], { write: (line) => usage.push(line) });
  assert.match(usage.join('\n'), /leave \[--force\] +end the pairing here/);
});

test('joining says what the runner keeps, and that nothing of it expires', async (t) => {
  const dataDir = dataDirectory(t);
  const lines = [];
  await runRunnerCommand(['join', 'synthetic-invitation', '--data-dir', dataDir], { write: (line) => lines.push(line),
    join: async () => ({ host: { name: 'Host A', address: '192.168.1.20', port: 2730 }, runner: { fingerprint: 'c'.repeat(64) } }),
    setupClients: async () => [{ id: 'codex', status: 'connected' }] });
  const said = lines.join('\n');
  assert.doesNotMatch(said, /nothing of FULI's knowledge is kept here/);
  assert.match(said, /Kept here: the host's last answers to read-only calls .*nothing is deleted because it is old.* A task token given out while the host is away lasts 30 days\./);
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
  writeFileSync(path.join(dataDir, 'runner', 'project-registry.json'), JSON.stringify({
    version: 1, spaceId: 'sample', device: 'a'.repeat(64), authority: HOST.fingerprint
  }));
  await assert.rejects(joinHost({ dataDir, invitation, force: true, loadIdentity: async () => { loaded = true; return other; } }),
    { code: 'project_registry_pairing_changed' });
  assert.equal(loaded, false);
});

test('a revoked follower keeps its waiting checkpoints, refused, and loses what it had read', () => {
  let now = Date.parse('2026-11-01T00:00:00Z');
  const store = pairedRunner({ now: () => now });
  for (const id of ['old-1', 'old-2']) {
    store.enqueue({ id, tool: 'checkpoint_task_knowledge', input: {}, sourceApplication: 'codex' });
    store.failed(id, 'invalid_input');
  }
  now += 400 * DAY_MS;
  store.enqueue({ id: 'waiting', tool: 'checkpoint_task_knowledge', input: {}, sourceApplication: 'codex' });
  store.rememberAnswer('read:kept', 'search_knowledge_graph', { content: [] });
  store.revoked();
  assert.deepEqual(store.db.prepare('SELECT id, last_error FROM outbox ORDER BY seq').all()
    .map((row) => [row.id, row.last_error]),
  [['old-1', 'invalid_input'], ['old-2', 'invalid_input'], ['waiting', 'runner_revoked']]);
  assert.equal(store.answer('read:kept'), null, 'what was read from the host goes at once');
});

// Review of #1069: on Windows a client's process can hold the store open, so `leave` could not delete
// it, and the empty file kept the computer counted as a follower for ever.
test('a pairing left while its store was held open no longer makes this computer a follower', async (t) => {
  const dataDir = dataDirectory(t);
  mkdirSync(path.join(dataDir, 'runner'));
  const store = new RunnerStore(path.join(dataDir, RUNNER_FILE));
  store.saveHost(HOST);
  store.close();
  assert.equal(isRunnerDataDirectory(dataDir), true);
  const result = await runRunnerCommand(['leave', '--data-dir', dataDir], { write: () => {},
    remove: () => { throw Object.assign(new Error('synthetic: the file is in use'), { code: 'EBUSY' }); } });
  assert.equal(result.exitCode, 0);
  assert.equal(existsSync(path.join(dataDir, RUNNER_FILE)), true, 'the file stayed');
  assert.equal(isRunnerDataDirectory(dataDir), false, 'but the pairing is over');
});

// A bounded MCP entry the host gave for a synthetic folder, and its whole set.
const BOUNDED = {
  call: { tool: 'get_collaboration_preferences', input: { projectPath: '/synthetic/repo' } },
  hard: { preference_key: 'hard-rule', instruction: 'Synthetic hard rule.' },
  whole: ['hard-rule', 'ranked', 'other-a', 'other-b', 'other-c'].map((key) => ({ preference_key: key, instruction: `Synthetic ${key}.` })),
  context: { personal_space_id: 'space-a', personal_project_id: 'project-a', project_agent_id: 'agent-a' },
  read: { tool: 'read_task_preferences', arguments: { taskContextToken: 'host-token' } }
};
const answerOf = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
function rememberBounded(store) {
  rememberAnswer(store, BOUNDED.call, answerOf({ effective_preferences: [BOUNDED.hard, BOUNDED.whole[1]],
    preferences_omitted: { count: 3, index: ['other-a — synthetic line'], read: BOUNDED.read },
    taskContextToken: 'host-token', context: BOUNDED.context, preferences_revision: 'abcdef012345' }));
  rememberAnswer(store, BOUNDED.call, answerOf({ effective_preferences: [BOUNDED.hard],
    preferences_omitted: { count: 4, unchanged: true, read: BOUNDED.read }, taskContextToken: 'host-token-2',
    context: BOUNDED.context, preferences_revision: 'abcdef012345' }));
}

test('an offline entry without the whole read kept says its rest cannot be read, never an answer that held only the hard rules', () => {
  const store = pairedRunner();
  rememberBounded(store);
  const offline = text(offlineAnswer(store, { ...BOUNDED.call, sourceApplication: 'codex' }));
  assert.deepEqual(offline.effective_preferences.map((item) => item.preference_key), ['hard-rule', 'ranked']);
  assert.deepEqual(offline.preferences_omitted, { count: 3, index: ['other-a — synthetic line'] });
  assert.equal(offline.omitted_guidance, OMITTED_UNREADABLE_LABEL);
  const read = offlineAnswer(store, { tool: 'read_task_preferences', input: { taskContextToken: offline.taskContextToken } });
  assert.equal(read.isError, true);
  assert.equal(text(read).code, 'host_unreachable');
  assert.match(text(read).message, /tell the person and ask/);
  store.close();
});

test('an offline entry reads the rest from the whole read kept for its set, read once per revision', async () => {
  const store = pairedRunner();
  rememberBounded(store);
  const reads = [];
  const read = async (input) => { reads.push(input); return { effective_preferences: BOUNDED.whole, context: BOUNDED.context }; };
  // The first entry and the unchanged one after it share the revision: the host is read once.
  assert.equal(await keepWholeEntry(store, answerOf({ effective_preferences: [BOUNDED.hard], preferences_omitted: { count: 4 },
    taskContextToken: 'host-token', context: BOUNDED.context, preferences_revision: 'abcdef012345' }), read), 'whole');
  assert.equal(await keepWholeEntry(store, answerOf({ effective_preferences: [BOUNDED.hard], preferences_omitted: { count: 4 },
    taskContextToken: 'host-token-2', context: BOUNDED.context, preferences_revision: 'abcdef012345' }), read), 'kept');
  assert.deepEqual(reads, [{ taskContextToken: 'host-token' }]);
  const offline = text(offlineAnswer(store, { ...BOUNDED.call, sourceApplication: 'codex' }));
  // Still the bounded view, its read under this offline task's own token.
  assert.deepEqual(offline.effective_preferences.map((item) => item.preference_key), ['hard-rule', 'ranked']);
  assert.deepEqual(offline.preferences_omitted.read, { ...BOUNDED.read, arguments: { taskContextToken: offline.taskContextToken } });
  assert.match(offline.omitted_guidance, /preferences_omitted/);
  assert.equal(offline.omitted_guidance.includes(OMITTED_UNREADABLE_LABEL), false);
  const all = text(offlineAnswer(store, { tool: 'read_task_preferences', input: offline.preferences_omitted.read.arguments }));
  assert.deepEqual(all.effective_preferences.map((item) => item.preference_key), BOUNDED.whole.map((item) => item.preference_key));
  assert.equal(all.preferences_complete, true);
  assert.equal(all.runner.offline, true);
  const some = text(offlineAnswer(store, { tool: 'read_task_preferences',
    input: { ...offline.preferences_omitted.read.arguments, keys: ['other-b'] } }));
  assert.deepEqual(some.effective_preferences.map((item) => item.preference_key), ['other-b']);
  store.close();
});

test('an enrolled follower can re-pair with its original host while retaining a populated project', async t => {
  const { installationPhase } = await import('../src/runner/project-installation.js');
  const { writeRecord } = await import('../src/runner/follower-local-runtime.js');
  const { RoutesStore, ROUTES_FILE } = await import('../src/runner/routes-store.js');
  const dataDir = mkdtempSync(path.join(tmpdir(), 'fuli-populated-rejoin-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  let requests = 0;
  const { store, listener } = await tlsPair(t, (_req, res) => {
    requests++;
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ name: 'Host' }));
    return true;
  });
  const saved = store.host();
  const runner = deviceIdentity(await createDeviceCertificate());
  const descriptor = { version: 1, device: runner.fingerprint, authority: saved.fingerprint, spaceId: 'registered-space' };
  installationPhase(dataDir, descriptor);
  installationPhase(dataDir, descriptor, true);
  writeFileSync(path.join(dataDir, 'runner', 'project-registry.json'), JSON.stringify(descriptor));
  writeFileSync(path.join(dataDir, 'graph-runtime.json'), JSON.stringify({ personal: { spaceId: descriptor.spaceId } }));
  writeRecord(dataDir, { state: 'ready', createdHere: true, projects: ['kept'], space: { state: 'same', id: descriptor.spaceId } });
  const local = new RunnerStore(path.join(dataDir, RUNNER_FILE));
  const routes = new RoutesStore(path.join(dataDir, ROUTES_FILE));
  try {
    local.saveHost(saved); local.revoked(); routes.installMove('project:kept', 'local');
    const invitation = encodeInvitation({ ...saved, port: listener.port, code: newInvitationCode() });
    const replaced = deviceIdentity(await createDeviceCertificate());
    await assert.rejects(joinHost({ dataDir, invitation, loadIdentity: async () => replaced }), { code: 'project_registry_pairing_changed' });
    assert.equal(requests, 0);
    await joinHost({ dataDir, invitation, loadIdentity: async () => runner });
    assert.equal(requests, 1);
    assert.equal(local.host().revokedAt, null);
    assert.equal(routes.owner('project:kept'), 'local');
  } finally { local.close(); routes.close(); store.close(); }
});

test('retiring historical inventory requires the person to confirm the exact pairing on a terminal', async t => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'fuli-retire-inventory-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const fingerprint = 'a'.repeat(64);
  const methods = [];
  const options = { interactive: () => false, confirm: async () => false, write() {},
    fetchImpl: async (_url, { method, body }) => {
      methods.push(method);
      if (method === 'POST') assert.deepEqual(JSON.parse(body), { pairing: 'reviewed-epoch' });
      return Response.json({ pairing: 'reviewed-epoch', revokedAt: 'then', checkedAt: null, retiredAt: null });
    } };
  const run = () => runRunnerCommand(['retire-inventory', fingerprint, '--data-dir', dataDir], options);
  await assert.rejects(run(), /terminal/);
  options.interactive = () => true;
  await run();
  assert.deepEqual(methods, ['GET', 'GET']);
  options.confirm = async (question, { defaultYes }) => { assert.ok(question.includes(fingerprint)); return !defaultYes; };
  await run();
  assert.deepEqual(methods, ['GET', 'GET', 'GET', 'POST']);
});
