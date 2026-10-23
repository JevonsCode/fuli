import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import { agentAppContext, agentAppServiceOver } from '../src/agent-apps/service.js';
import { createVerifiedDecisions } from '../src/agent-apps/verified-decisions.js';
import { presencePort } from '../src/presence/port.js';
import { fakeHelper, windowsHello } from '../test-support/fake-win-helper.js';

// rec#7 part 2 PR①: presence-checked approval and rollback, and the run gate.
// Every presence here is a fake or a synthetic helper stand-in: these tests
// prove the state machine only. No real Windows Hello is ever asked for.

const CLI_USER = Object.freeze({ entrypoint: 'cli', user: 'fixture-user' });
const CONSOLE = Object.freeze({ entrypoint: 'http', user: 'local-console' });
const TOOLS = ['search_knowledge_graph'];
const MANIFEST = Object.freeze({
  schemaVersion: 1, name: 'dispatch-log', version: '1.0.0', title: 'Dispatch log',
  description: 'Synthetic fixture page that lists dispatched replies.',
  permissions: ['fuli.search_knowledge_graph'],
  runtime: { apiVersion: 1, webRoot: 'web' },
  data: { scope: 'app', format: 1 }
});
const FILES = Object.freeze([{ path: 'web/index.html', content: '<h1>Synthetic dispatch log</h1>' }]);

const verified = () => ({ verified: true });
const refused = (reason, detail = 'fixture') => ({ verified: false, reason, detail });

// presence answers each check in turn and records the challenges it saw.
function fixture(t, { platform = 'win32', answers = [verified()] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-app-presence-'));
  const root = join(directory, 'agent-apps');
  const clock = { now: Date.parse('2026-10-24T08:00:00.000Z') };
  const context = agentAppContext({ root, providerIdentity: 'http://127.0.0.1:65530', platform,
    resolveOwner: async (owner) => owner, toolNames: () => TOOLS, clock: () => new Date(clock.now) });
  const service = agentAppServiceOver(context);
  const asked = [];
  const presence = { kind: 'hello', verify: async (challenge) => { asked.push(challenge); return answers.shift() ?? verified(); } };
  const decisions = createVerifiedDecisions(context, { presence });
  const opened = [service];
  // Another connection to the same registry, as a second CLI process would open.
  const reopen = (options = {}) => {
    const again = agentAppContext({ root, platform, toolNames: () => TOOLS, clock: () => new Date(clock.now), ...options });
    opened.push(again.store);
    return again;
  };
  // Every registry connection closes before Windows lets its directory go.
  t.after(() => {
    for (const each of opened) each.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { root, clock, service, decisions, asked, answers, reopen };
}

async function submitted(service, manifest = {}) {
  return service.submit({ personalSpaceId: 'space-a', agentId: 'agent-jvs', manifest: { ...MANIFEST, ...manifest }, files: FILES });
}

const approval = ({ appId, version, digest }) => ({ appId, version, digest, approver: CLI_USER });
const consumed = (service, appId) => service.read({ appId }).history
  .filter(({ action }) => action === 'challenge_consumed').map(({ detail }) => detail.outcome);

test('a verified approval records the challenge it consumed and still stops at the run gate', async (t) => {
  const { service, decisions, asked } = fixture(t);
  const app = await submitted(service);

  const approved = await decisions.approve(approval(app));

  assert.equal(approved.status, 'active');
  assert.equal(asked.length, 1);
  assert.deepEqual(approved.approval, { entrypoint: 'cli', presence: 'hello', verification: 'os_user_verified',
    challengeId: asked[0].challengeId, verifiedAt: '2026-10-24T08:00:00.000Z' });
  const detail = service.read({ appId: app.appId });
  assert.equal(detail.versions[0].approval.challengeId, asked[0].challengeId);
  assert.deepEqual(consumed(service, app.appId), ['verified']);
  // Presence passes; this version has no isolation backend, so nothing runs.
  assert.equal(detail.run.reason, 'isolation_unavailable');
  assert.equal(service.list({}).apps[0].run.reason, 'isolation_unavailable');
});

for (const [reason, outcome] of [['presence_canceled', refused('presence_canceled', 'hello_Canceled')],
  ['presence_failed', refused('presence_failed', 'hello_RetriesExhausted')],
  ['presence_unavailable', refused('presence_unavailable', 'helper_timeout')],
  ['presence_unsupported_platform', refused('presence_unsupported_platform', 'linux')],
  ['presence_unavailable', { unexpected: true }]]) {
  test(`a ${reason} answer approves nothing and is recorded unverified (${outcome.detail ?? 'malformed'})`, async (t) => {
    const { service, decisions } = fixture(t, { answers: [outcome] });
    const app = await submitted(service);

    await assert.rejects(decisions.approve(approval(app)), (error) => error.code === reason
      && /unverified/.test(error.message));

    const detail = service.read({ appId: app.appId });
    assert.equal(detail.status, 'pending');
    assert.equal(detail.versions[0].state, 'pending');
    assert.equal(detail.versions[0].approval, null);
    assert.deepEqual(consumed(service, app.appId), [reason]);
    assert.equal(detail.run.reason, 'presence_unverified');
  });
}

test('a challenge is consumed once: a replay and a stale challenge are refused', async (t) => {
  const { service, decisions } = fixture(t);
  const app = await submitted(service);
  const challenge = decisions.issueChallenge({ action: 'approve', ...approval(app) });

  assert.throws(() => decisions.commitChallenge({ ...challenge, nonce: 'guessed' }, verified(), CLI_USER),
    { code: 'challenge_mismatch' });
  assert.equal(decisions.commitChallenge(challenge, verified(), CLI_USER).status, 'active');
  assert.throws(() => decisions.commitChallenge(challenge, verified(), CLI_USER), { code: 'challenge_replayed' });

  const second = await submitted(service, { version: '1.0.1' });
  const stale = decisions.issueChallenge({ action: 'approve', ...approval(second) });
  decisions.issueChallenge({ action: 'approve', ...approval(second) });
  assert.throws(() => decisions.commitChallenge(stale, verified(), CLI_USER), { code: 'challenge_mismatch' });
  assert.equal(service.read({ appId: app.appId }).version, '1.0.0');
});

test('an expired challenge is consumed without approving, even with a verified answer', async (t) => {
  const { service, decisions, clock } = fixture(t);
  const app = await submitted(service);
  const challenge = decisions.issueChallenge({ action: 'approve', ...approval(app) });

  clock.now += 10 * 60_000;
  assert.throws(() => decisions.commitChallenge(challenge, verified(), CLI_USER), { code: 'challenge_expired' });
  assert.throws(() => decisions.commitChallenge(challenge, verified(), CLI_USER), { code: 'challenge_replayed' });
  assert.equal(service.read({ appId: app.appId }).status, 'pending');
  assert.deepEqual(consumed(service, app.appId), ['challenge_expired']);
});

test('terms or package changed after the verification are not covered by it', async (t) => {
  const { service, decisions, root } = fixture(t);
  const first = await submitted(service);
  await decisions.approve(approval(first));
  const second = await submitted(service, { version: '1.0.1' });

  // The console disables the app between the Hello prompt and the commit.
  const challenge = decisions.issueChallenge({ action: 'approve', ...approval(second) });
  service.disable({ appId: first.appId, actor: CONSOLE });
  assert.throws(() => decisions.commitChallenge(challenge, verified(), CLI_USER), { code: 'challenge_mismatch' });
  const afterTerms = service.read({ appId: first.appId });
  assert.deepEqual([afterTerms.status, afterTerms.version, afterTerms.versions[1].state], ['disabled', '1.0.0', 'pending']);

  // The package on disk changes after the prompt: consumed, refused, nothing activated.
  await decisions.rollback({ appId: first.appId, version: '1.0.0', actor: CLI_USER });
  const third = await submitted(service, { version: '1.0.2' });
  const pending = decisions.issueChallenge({ action: 'approve', ...approval(third) });
  const page = join(root, 'packages', first.appId, '1.0.2', 'web', 'index.html');
  writeFileSync(page, '<h1>Swapped on disk</h1>');
  assert.throws(() => decisions.commitChallenge(pending, verified(), CLI_USER), { code: 'package_tampered' });
  assert.equal(service.read({ appId: first.appId }).version, '1.0.0');
  assert.deepEqual(consumed(service, first.appId).slice(-1), ['package_tampered']);

  // The approved package changes after approval: the gate no longer accepts it.
  assert.equal(service.read({ appId: first.appId }).run.reason, 'isolation_unavailable');
  writeFileSync(join(root, 'packages', first.appId, '1.0.0', 'web', 'index.html'), '<h1>Swapped later</h1>');
  assert.equal(service.read({ appId: first.appId }).run.reason, 'challenge_mismatch');
});

test('a rollback needs its own presence check and never restores an earlier one', async (t) => {
  const { service, decisions } = fixture(t, { answers: [verified(), verified(), refused('presence_canceled')] });
  const first = await submitted(service);
  await decisions.approve(approval(first));
  const second = await submitted(service, { version: '1.0.1' });
  await decisions.approve(approval(second));

  await assert.rejects(decisions.rollback({ appId: first.appId, version: '1.0.0', actor: CLI_USER }),
    { code: 'presence_canceled' });
  const kept = service.read({ appId: first.appId });
  assert.equal(kept.version, '1.0.1');
  assert.equal(kept.run.reason, 'isolation_unavailable');

  // The console's rollback has no presence check, so it rewrites the old one as unverified.
  service.rollback({ appId: first.appId, version: '1.0.0', actor: CONSOLE });
  const consoleRollback = service.read({ appId: first.appId });
  assert.equal(consoleRollback.version, '1.0.0');
  assert.equal(consoleRollback.versions[0].approval.presence, 'unverified');
  assert.equal(consoleRollback.versions[0].approval.challengeId, null);
  assert.equal(consoleRollback.run.reason, 'presence_unverified');

  const restored = await decisions.rollback({ appId: first.appId, version: '1.0.1', actor: CLI_USER });
  assert.equal(restored.approval.presence, 'hello');
  assert.equal(service.read({ appId: first.appId }).run.reason, 'isolation_unavailable');
});

// A failure after the verification attempt still consumes the challenge, in a
// transaction of its own, and leaves the approval and the versions untouched.
function assertConsumedWithoutApproval(service, appId, { version, status, outcome, detail }) {
  const read = service.read({ appId });
  assert.deepEqual([read.status, read.version], [status, version]);
  const event = read.history.filter(({ action }) => action === 'challenge_consumed').at(-1);
  assert.deepEqual([event.detail.outcome, event.detail.detail], [outcome, detail]);
  assert.equal(read.history.some(({ action, detail: recorded }) => action === 'approved'
    && recorded.challengeId === event.detail.challengeId), false);
}

const failingData = (code) => () => { throw Object.assign(new Error(`synthetic ${code}`), { code }); };

for (const [label, breakData, code] of [
  ['the data root is a file', ({ root }) => writeFileSync(join(root, 'data'), 'not a directory'), 'ENOTDIR'],
  ['the data directory is not writable', ({ context }) => { context.dataOf = failingData('EACCES'); }, 'EACCES']
]) {
  test(`a verified approval that fails because ${label} consumes its challenge and approves nothing`, async (t) => {
    const { service, reopen, root } = fixture(t);
    const app = await submitted(service);
    const context = reopen();
    const decisions = createVerifiedDecisions(context, { presence: { kind: 'hello' } });
    const challenge = decisions.issueChallenge({ action: 'approve', ...approval(app) });
    breakData({ root, context });

    assert.throws(() => decisions.commitChallenge(challenge, verified(), CLI_USER), { code });

    // While the data path is still broken, the registry itself shows the outcome.
    const { store } = context;
    assert.deepEqual([store.app(app.appId).status, store.version(app.appId, '1.0.0').state,
      store.approval(app.appId, '1.0.0')], ['pending', 'pending', null]);
    assert.notEqual(store.challenge(app.appId).consumedAt, null);
    assert.throws(() => decisions.commitChallenge(challenge, verified(), CLI_USER), { code: 'challenge_replayed' });

    // The data path is repaired; the same challenge and answer still cannot be committed.
    rmSync(join(root, 'data'), { recursive: true, force: true });
    context.dataOf = (appId) => join(root, 'data', appId);
    assert.throws(() => decisions.commitChallenge(challenge, verified(), CLI_USER), { code: 'challenge_replayed' });
    assertConsumedWithoutApproval(service, app.appId, { status: 'pending', version: null, outcome: 'decision_failed', detail: code });
    assert.equal(service.read({ appId: app.appId }).versions[0].approval, null);
  });
}

// The interleaving dot found in round 2: a rival holding the same challenge and
// answer commits right after the failing commit claimed it (before it
// finalizes) or right after its finalize rolled back (before the failure is
// recorded). Neither rival may approve, and the challenge never reopens.
test('a rival commit racing a failed one at either step boundary never approves it', async (t) => {
  const { service, reopen } = fixture(t);
  for (const [boundary, name] of [[2, 'race-before-finalize'], [3, 'race-before-failure-record']]) {
    const app = await submitted(service, { name });
    const failingContext = reopen();
    failingContext.dataOf = failingData('EACCES');
    const failing = createVerifiedDecisions(failingContext, { presence: { kind: 'hello' } });
    const rival = createVerifiedDecisions(reopen(), { presence: { kind: 'hello' } });
    const challenge = failing.issueChallenge({ action: 'approve', ...approval(app) });
    // Transactions of the failing commit: 1 claim, 2 finalize, 3 record the failure.
    const transaction = failingContext.store.transaction.bind(failingContext.store);
    const rivalOutcomes = [];
    let calls = 0;
    failingContext.store.transaction = (operation) => {
      calls += 1;
      if (calls === boundary) {
        try {
          rival.commitChallenge(challenge, verified(), CLI_USER);
          rivalOutcomes.push('approved');
        } catch (error) {
          rivalOutcomes.push(error.code);
        }
      }
      return transaction(operation);
    };

    assert.throws(() => failing.commitChallenge(challenge, verified(), CLI_USER), { code: 'EACCES' });

    assert.deepEqual([calls, rivalOutcomes], [3, ['challenge_replayed']], `boundary ${boundary}`);
    assertConsumedWithoutApproval(service, app.appId, { status: 'pending', version: null, outcome: 'decision_failed', detail: 'EACCES' });
    assert.equal(service.read({ appId: app.appId }).versions[0].approval, null);
    assert.throws(() => rival.commitChallenge(challenge, verified(), CLI_USER), { code: 'challenge_replayed' });
  }
});

test('a verified rollback that fails on its data directory keeps the running version', async (t) => {
  const { service, decisions, reopen } = fixture(t);
  const first = await submitted(service);
  await decisions.approve(approval(first));
  const second = await submitted(service, { version: '1.0.1' });
  await decisions.approve(approval(second));
  const context = reopen();
  context.dataOf = failingData('EACCES');
  const failing = createVerifiedDecisions(context, { presence: { kind: 'hello', verify: async () => verified() } });

  await assert.rejects(failing.rollback({ appId: first.appId, version: '1.0.0', actor: CLI_USER }), { code: 'EACCES' });

  assertConsumedWithoutApproval(service, first.appId, { status: 'active', version: '1.0.1', outcome: 'decision_failed', detail: 'EACCES' });
  const read = service.read({ appId: first.appId });
  assert.equal(read.versions[0].approval.challengeId, read.history.find(({ action }) => action === 'approved').detail.challengeId,
    'the earlier approval of 1.0.0 is not rewritten');
  assert.equal(read.run.reason, 'isolation_unavailable');
});

for (const [label, outcome] of [['null', null], ['undefined', undefined]]) {
  test(`a ${label} presence answer is unavailable, consumed and never reusable`, async (t) => {
    const { service, decisions } = fixture(t);
    const app = await submitted(service);
    const challenge = decisions.issueChallenge({ action: 'approve', ...approval(app) });

    assert.throws(() => decisions.commitChallenge(challenge, outcome, CLI_USER), { code: 'presence_unavailable' });
    assertConsumedWithoutApproval(service, app.appId, { status: 'pending', version: null, outcome: 'presence_unavailable',
      detail: undefined });
    assert.throws(() => decisions.commitChallenge(challenge, verified(), CLI_USER), { code: 'challenge_replayed' });
  });
}

test('a presence check that throws is unavailable and still consumes the challenge', async (t) => {
  const { service, reopen } = fixture(t);
  const app = await submitted(service);
  const presence = { kind: 'hello', verify: async () => { throw new Error('synthetic helper crash'); } };
  const decisions = createVerifiedDecisions(reopen(), { presence });

  await assert.rejects(decisions.approve(approval(app)), { code: 'presence_unavailable' });
  assertConsumedWithoutApproval(service, app.appId, { status: 'pending', version: null, outcome: 'presence_unavailable',
    detail: 'presence_check_failed' });
  assert.equal(service.read({ appId: app.appId }).versions[0].approval, null);
});

test('two processes consuming one nonce at once: exactly one approval wins', async (t) => {
  const { service, decisions, root } = fixture(t);
  const app = await submitted(service);
  const challenge = decisions.issueChallenge({ action: 'approve', ...approval(app) });
  const gate = new SharedArrayBuffer(4);
  const worker = () => new Worker(`
    const { workerData, parentPort } = require('node:worker_threads');
    (async () => {
      const { agentAppContext } = await import(workerData.service);
      const { createVerifiedDecisions } = await import(workerData.decisions);
      const context = agentAppContext({ root: workerData.root, toolNames: () => workerData.tools, platform: 'win32' });
      void context.store.database;
      const decisions = createVerifiedDecisions(context, { presence: { kind: 'hello' } });
      parentPort.postMessage('ready');
      Atomics.wait(new Int32Array(workerData.gate), 0, 0);
      try {
        decisions.commitChallenge(workerData.challenge, { verified: true }, { entrypoint: 'cli', user: 'fixture-user' });
        parentPort.postMessage('won');
      } catch (error) {
        parentPort.postMessage(error.code ?? error.message);
      } finally {
        context.store.close();
      }
    })();`, { eval: true, workerData: { gate, root, tools: TOOLS, challenge,
    service: new URL('../src/agent-apps/service.js', import.meta.url).href,
    decisions: new URL('../src/agent-apps/verified-decisions.js', import.meta.url).href } });
  const workers = [worker(), worker()];
  const answers = workers.map((each) => {
    const messages = [];
    return { ready: new Promise((resolve) => each.on('message', (message) => {
      messages.push(message);
      if (message === 'ready') resolve();
    })), done: new Promise((resolve) => each.on('exit', () => resolve(messages.at(-1)))) };
  });
  await Promise.all(answers.map(({ ready }) => ready));
  Atomics.store(new Int32Array(gate), 0, 1);
  Atomics.notify(new Int32Array(gate), 0);
  const results = (await Promise.all(answers.map(({ done }) => done))).sort();

  assert.deepEqual(results, ['challenge_replayed', 'won']);
  assert.deepEqual(consumed(service, app.appId), ['verified']);
  assert.equal(service.read({ appId: app.appId }).history.filter(({ action }) => action === 'approved').length, 1);
});

test('a console approval is unverified and the gate refuses it; other platforms are refused outright', async (t) => {
  const { service } = fixture(t);
  const app = await submitted(service);
  service.approve({ ...approval(app), approver: CONSOLE });
  assert.equal(service.read({ appId: app.appId }).run.reason, 'presence_unverified');

  const linux = fixture(t, { platform: 'linux' });
  const other = await submitted(linux.service);
  const port = presencePort({ platform: 'linux' });
  assert.equal(port.kind, null);
  const decisions = createVerifiedDecisions(linux.reopen(), { presence: port });
  await assert.rejects(decisions.approve(approval(other)), { code: 'presence_unsupported_platform' });
  assert.equal(linux.service.read({ appId: other.appId }).status, 'pending');
  assert.equal(linux.service.read({ appId: other.appId }).run.reason, 'presence_unsupported_platform');
  assert.match(linux.service.read({ appId: other.appId }).run.message, /本平台尚无在场证明，应用不能运行/);
});

test('approvals written before presence checks migrate and count as unverified', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-app-presence-legacy-'));
  const root = join(directory, 'agent-apps');
  // A part 1 registry: unversioned, presence only, with a claimed (never checked) hello.
  mkdirSync(root, { recursive: true });
  const legacy = new DatabaseSync(join(root, 'registry.sqlite'));
  legacy.exec(`CREATE TABLE agent_apps (app_id TEXT PRIMARY KEY, provider TEXT NOT NULL, personal_space_id TEXT NOT NULL,
      agent_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, active_version TEXT, data_format INTEGER,
      deletion_ticket TEXT, deletion_expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_used_at TEXT);
    CREATE TABLE agent_app_versions (app_id TEXT NOT NULL, version TEXT NOT NULL, state TEXT NOT NULL, digest TEXT NOT NULL,
      manifest TEXT NOT NULL, files INTEGER NOT NULL, bytes INTEGER NOT NULL, submitted_at TEXT NOT NULL, PRIMARY KEY (app_id, version));
    CREATE TABLE agent_app_approvals (app_id TEXT NOT NULL, version TEXT NOT NULL, digest TEXT NOT NULL, permissions TEXT NOT NULL,
      data TEXT NOT NULL, resident INTEGER NOT NULL, approved_by TEXT NOT NULL,
      entrypoint TEXT NOT NULL CHECK (entrypoint IN ('cli', 'http')),
      presence TEXT NOT NULL CHECK (presence IN ('unverified', 'hello', 'touchid', 'polkit')),
      approved_at TEXT NOT NULL, PRIMARY KEY (app_id, version));
    CREATE TABLE agent_app_tokens (token_hash TEXT PRIMARY KEY, app_id TEXT NOT NULL, version TEXT NOT NULL, digest TEXT NOT NULL,
      permissions TEXT NOT NULL, issued_at TEXT NOT NULL, revoked_at TEXT, revoked_reason TEXT);
    CREATE TABLE agent_app_events (id INTEGER PRIMARY KEY AUTOINCREMENT, app_id TEXT NOT NULL, at TEXT NOT NULL,
      action TEXT NOT NULL, version TEXT, actor TEXT, detail TEXT);`);
  const appId = `app-${'a'.repeat(32)}`;
  const manifest = { ...MANIFEST, resident: false, data: { scope: 'app', format: 1, accepts: [1], migration: 'none' } };
  const at = '2026-10-20T08:00:00.000Z';
  legacy.prepare('INSERT INTO agent_apps VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL)')
    .run(appId, 'http://127.0.0.1:65530', 'space-a', 'agent-jvs', 'dispatch-log', 'active', '1.0.0', 1, at, at);
  legacy.prepare('INSERT INTO agent_app_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(appId, '1.0.0', 'approved', 'f'.repeat(64), JSON.stringify(manifest), 1, 32, at);
  legacy.prepare('INSERT INTO agent_app_approvals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(appId, '1.0.0', 'f'.repeat(64), JSON.stringify(manifest.permissions), JSON.stringify(manifest.data), 0,
      'fixture-user', 'cli', 'hello', at);
  legacy.close();

  const service = agentAppServiceOver(agentAppContext({ root, platform: 'win32', toolNames: () => TOOLS }));
  t.after(() => {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const read = service.read({ appId });
  assert.deepEqual([read.versions[0].approval.presence, read.versions[0].approval.verification,
    read.versions[0].approval.challengeId], ['hello', null, null]);
  assert.equal(read.run.reason, 'presence_unverified');
  const ledger = new DatabaseSync(join(root, 'registry.sqlite'), { readOnly: true });
  try {
    assert.equal(ledger.prepare('PRAGMA user_version').get().user_version, 3);
  } finally {
    ledger.close();
  }
});

test('a helper whose digest does not match records the approval attempt unverified', async (t) => {
  const { service, reopen } = fixture(t);
  const app = await submitted(service);
  const helper = fakeHelper({ answer: { stage: 'verification', result: 'Verified' } });
  const decisions = createVerifiedDecisions(reopen(),
    { presence: windowsHello(t, { pinnedDigest: '0'.repeat(64), spawnHelper: helper.spawnHelper }) });

  await assert.rejects(decisions.approve(approval(app)), { code: 'presence_unavailable' });
  assert.equal(helper.runs.length, 0);
  assert.equal(service.read({ appId: app.appId }).status, 'pending');
  const event = service.read({ appId: app.appId }).history.find(({ action }) => action === 'challenge_consumed');
  assert.deepEqual([event.detail.outcome, event.detail.detail], ['presence_unavailable', 'helper_digest_mismatch']);
});
