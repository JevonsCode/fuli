import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import { createConfirmedDecisions } from '../src/agent-apps/confirmed-decisions.js';
import { agentAppContext, agentAppServiceOver } from '../src/agent-apps/service.js';
import { AGENT_APP_FORMAT } from '../src/agent-apps/store.js';
import { CONFIRMATION_NOTICE, TRUST_WARNING } from '../src/agent-apps/trust-terms.js';
import { applyConfirmedSqliteMigration, previewSqliteMigration } from '../packages/roundtable/src/storage/database-migration.js';
import { fakeHelper, windowsHello } from '../test-support/fake-win-helper.js';

// rec#7 PR②b (rec#11 D-36.1, D-36.2, D-36.9): approval and rollback through
// the terminal confirmation flow, the trusted-mode run gate, and approvals of
// the earlier isolated mode that are never carried over. The confirmation is a
// fake prompt answering with a typed line, Windows Hello a fake port or a
// synthetic helper stand-in: these tests prove the state machine only.

const CLI_USER = Object.freeze({ entrypoint: 'cli', user: 'fixture-user' });
const CONSOLE = Object.freeze({ entrypoint: 'http', user: 'local-console' });
const TOOLS = ['resolve_knowledge_tags'];
const NAME = 'dispatch-log';
const MANIFEST = Object.freeze({
  schemaVersion: 1, name: NAME, version: '1.0.0', title: 'Dispatch log',
  description: 'Synthetic fixture page that lists dispatched replies.',
  permissions: ['fuli.resolve_knowledge_tags'],
  runtime: { apiVersion: 1, webRoot: 'web' },
  data: { scope: 'app', format: 1 }
});
const FILES = Object.freeze([{ path: 'web/index.html', content: '<h1>Synthetic dispatch log</h1>' }]);

const typed = (line = NAME) => ({ typed: line });
// Every context here is this test process; no other host holds an app.
const HOST = Object.freeze({ platform: 'test', self: async () => ({ pid: 101, identity: 'test:101', exePath: '/synthetic/node' }),
  identify: async () => null, probe: async () => 'unknown' });

// Every context in a test reads this fixed time, worker threads too, so a
// challenge never expires by the wall clock while the test runs.
const FIXTURE_NOW = Date.parse('2026-10-24T08:00:00.000Z');

// The prompt answers each confirmation in turn (the app name by default) and
// records the challenges it showed.
function fixture(t, { answers = [] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-app-approval-'));
  const root = join(directory, 'agent-apps');
  const clock = { now: FIXTURE_NOW };
  const context = agentAppContext({ root, providerIdentity: 'http://127.0.0.1:65530', hostIdentity: HOST,
    resolveOwner: async (owner) => owner, toolNames: () => TOOLS, clock: () => new Date(clock.now) });
  const service = agentAppServiceOver(context);
  const asked = [];
  const confirmation = { ask: async (challenge) => {
    asked.push(challenge);
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return answer === undefined ? challenge.appName : answer;
  } };
  const decisions = createConfirmedDecisions(context, { confirmation });
  const opened = [service];
  // Another connection to the same registry, as a second CLI process would open.
  const reopen = (options = {}) => {
    const again = agentAppContext({ root, toolNames: () => TOOLS, clock: () => new Date(clock.now), hostIdentity: HOST,
      ...options });
    opened.push(again.store);
    return again;
  };
  // Every registry connection closes before Windows lets its directory go.
  t.after(() => {
    for (const each of opened) each.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { root, clock, service, decisions, confirmation, asked, answers, reopen };
}

async function submitted(service, manifest = {}) {
  return service.submit({ personalSpaceId: 'space-a', agentId: 'agent-jvs', manifest: { ...MANIFEST, ...manifest }, files: FILES });
}

const approval = ({ appId, version, digest }) => ({ appId, version, digest, approver: CLI_USER });
const consumed = (service, appId) => service.read({ appId }).history
  .filter(({ action }) => action === 'challenge_consumed').map(({ detail }) => detail.outcome);

test('typing the app name approves in trusted mode, and the run gate then passes', async (t) => {
  const { service, decisions, asked } = fixture(t);
  const app = await submitted(service);

  const approved = await decisions.approve(approval(app));

  assert.equal(approved.status, 'active');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].appName, NAME);
  for (const shown of [`approve Agent app ${NAME} 1.0.0`, 'Dispatch log', app.digest, 'fuli.resolve_knowledge_tags',
    asked[0].challengeId, TRUST_WARNING.zh, TRUST_WARNING.en, CONFIRMATION_NOTICE.zh, CONFIRMATION_NOTICE.en]) {
    assert.ok(asked[0].message.includes(shown), shown);
  }
  assert.match(asked[0].message, /完成终端确认流程。这不证明是真人操作，也不能抵御以同一账户运行的其他程序。/);
  assert.match(asked[0].message, /这个应用会用你的账户权限在本机运行，FULI 不会隔离它。只批准你信任的应用。/);
  assert.deepEqual(approved.approval, { entrypoint: 'cli', presence: 'unverified', verification: 'terminal_confirmation',
    challengeId: asked[0].challengeId, verifiedAt: '2026-10-24T08:00:00.000Z', trustMode: 'trusted', termsVersion: 1 });
  const detail = service.read({ appId: app.appId });
  assert.deepEqual([detail.versions[0].approval.trustMode, detail.versions[0].approval.termsVersion], ['trusted', 1]);
  assert.deepEqual(consumed(service, app.appId), ['confirmed']);
  assert.deepEqual(detail.run, { status: 'ready', trustMode: 'trusted' });
  assert.deepEqual(service.list({}).apps[0].run, { status: 'ready', trustMode: 'trusted' });
  const event = detail.history.find(({ action }) => action === 'approved');
  assert.deepEqual(event.detail, { digest: app.digest, entrypoint: 'cli', presence: 'unverified',
    verification: 'terminal_confirmation', challengeId: asked[0].challengeId, trustMode: 'trusted', termsVersion: 1 });
});

for (const [label, answer, code] of [['a wrong name', 'dispatch-logs', 'confirmation_mismatch'],
  ['the title instead of the name', 'Dispatch log', 'confirmation_mismatch'],
  ['a cancelled prompt', null, 'confirmation_canceled'],
  ['an empty line', '', 'confirmation_canceled'],
  ['a prompt that fails', new Error('synthetic closed terminal'), 'confirmation_canceled']]) {
  test(`${label} approves nothing and consumes the challenge (${code})`, async (t) => {
    const { service, decisions } = fixture(t, { answers: [answer] });
    const app = await submitted(service);

    await assert.rejects(decisions.approve(approval(app)), (error) => error.code === code
      && /Nothing was approved/.test(error.message));

    const detail = service.read({ appId: app.appId });
    assert.deepEqual([detail.status, detail.versions[0].state, detail.versions[0].approval], ['pending', 'pending', null]);
    assert.deepEqual(consumed(service, app.appId), [code]);
    assert.equal(detail.run.reason, 'confirmation_required');
    // The line typed is never recorded.
    assert.doesNotMatch(JSON.stringify(detail.history), /dispatch-logs|synthetic closed terminal/);
  });
}

test('a challenge is consumed once: a replay and a stale challenge are refused', async (t) => {
  const { service, decisions } = fixture(t);
  const app = await submitted(service);
  const challenge = decisions.issueChallenge({ action: 'approve', ...approval(app) });

  assert.throws(() => decisions.commitChallenge({ ...challenge, nonce: 'guessed' }, typed(), CLI_USER),
    { code: 'challenge_mismatch' });
  assert.equal(decisions.commitChallenge(challenge, typed(), CLI_USER).status, 'active');
  assert.throws(() => decisions.commitChallenge(challenge, typed(), CLI_USER), { code: 'challenge_replayed' });

  const second = await submitted(service, { version: '1.0.1' });
  const stale = decisions.issueChallenge({ action: 'approve', ...approval(second) });
  decisions.issueChallenge({ action: 'approve', ...approval(second) });
  assert.throws(() => decisions.commitChallenge(stale, typed(), CLI_USER), { code: 'challenge_mismatch' });
  assert.equal(service.read({ appId: app.appId }).version, '1.0.0');
});

test('an expired challenge is consumed without approving, even with the right name', async (t) => {
  const { service, decisions, clock } = fixture(t);
  const app = await submitted(service);
  const challenge = decisions.issueChallenge({ action: 'approve', ...approval(app) });

  clock.now += 10 * 60_000;
  assert.throws(() => decisions.commitChallenge(challenge, typed(), CLI_USER), { code: 'challenge_expired' });
  assert.throws(() => decisions.commitChallenge(challenge, typed(), CLI_USER), { code: 'challenge_replayed' });
  assert.equal(service.read({ appId: app.appId }).status, 'pending');
  assert.deepEqual(consumed(service, app.appId), ['challenge_expired']);
});

test('terms, terms version or package changed after the prompt are not covered by the confirmation', async (t) => {
  const { service, decisions, root, reopen } = fixture(t);
  const first = await submitted(service);
  await decisions.approve(approval(first));
  const second = await submitted(service, { version: '1.0.1' });

  // The console disables the app between the prompt and the commit.
  const challenge = decisions.issueChallenge({ action: 'approve', ...approval(second) });
  await service.disable({ appId: first.appId, actor: CONSOLE });
  assert.throws(() => decisions.commitChallenge(challenge, typed(), CLI_USER), { code: 'challenge_mismatch' });
  const afterTerms = service.read({ appId: first.appId });
  assert.deepEqual([afterTerms.status, afterTerms.version, afterTerms.versions[1].state], ['disabled', '1.0.0', 'pending']);

  // A challenge issued under other approval terms (an earlier FULI's terms version) covers nothing now.
  await decisions.rollback({ appId: first.appId, version: '1.0.0', actor: CLI_USER });
  const older = decisions.issueChallenge({ action: 'approve', ...approval(second) });
  const { store } = reopen();
  const open = store.challenge(first.appId);
  store.saveChallenge(first.appId, { ...open, decision: { ...open.decision, termsVersion: 0 } });
  assert.throws(() => decisions.commitChallenge(older, typed(), CLI_USER),
    (error) => error.code === 'challenge_mismatch' && /other approval terms/.test(error.message));

  // The package on disk changes after the prompt: consumed, refused, nothing activated.
  const third = await submitted(service, { version: '1.0.2' });
  const pending = decisions.issueChallenge({ action: 'approve', ...approval(third) });
  writeFileSync(join(root, 'packages', first.appId, '1.0.2', 'web', 'index.html'), '<h1>Swapped on disk</h1>');
  assert.throws(() => decisions.commitChallenge(pending, typed(), CLI_USER), { code: 'package_tampered' });
  assert.equal(service.read({ appId: first.appId }).version, '1.0.0');
  assert.deepEqual(consumed(service, first.appId).slice(-1), ['package_tampered']);

  // The approved package changes after approval: the gate no longer accepts it.
  assert.equal(service.read({ appId: first.appId }).run.status, 'ready');
  writeFileSync(join(root, 'packages', first.appId, '1.0.0', 'web', 'index.html'), '<h1>Swapped later</h1>');
  assert.equal(service.read({ appId: first.appId }).run.reason, 'challenge_mismatch');
});

test('a rollback needs its own confirmation and never restores an earlier one', async (t) => {
  const { service, decisions } = fixture(t, { answers: [NAME, NAME, null] });
  const first = await submitted(service);
  await decisions.approve(approval(first));
  const second = await submitted(service, { version: '1.0.1' });
  await decisions.approve(approval(second));

  await assert.rejects(decisions.rollback({ appId: first.appId, version: '1.0.0', actor: CLI_USER }),
    { code: 'confirmation_canceled' });
  const kept = service.read({ appId: first.appId });
  assert.deepEqual([kept.version, kept.run.status], ['1.0.1', 'ready']);

  // The console's rollback completes no confirmation, so it rewrites the old one as unconfirmed.
  await service.rollback({ appId: first.appId, version: '1.0.0', actor: CONSOLE });
  const consoleRollback = service.read({ appId: first.appId });
  assert.equal(consoleRollback.version, '1.0.0');
  assert.deepEqual([consoleRollback.versions[0].approval.challengeId, consoleRollback.versions[0].approval.trustMode],
    [null, null]);
  assert.equal(consoleRollback.run.reason, 'confirmation_required');

  const restored = await decisions.rollback({ appId: first.appId, version: '1.0.1', actor: CLI_USER });
  assert.deepEqual([restored.approval.verification, restored.approval.trustMode], ['terminal_confirmation', 'trusted']);
  assert.equal(service.read({ appId: first.appId }).run.status, 'ready');
});

// A failure after the confirmation still consumes the challenge, in a
// transaction of its own, and leaves the approval and the versions untouched.
function assertConsumedWithoutApproval(service, appId, { version, status, outcome, detail }) {
  const read = service.read({ appId });
  assert.deepEqual([read.status, read.version], [status, version]);
  const event = read.history.filter(({ action }) => action === 'challenge_consumed').at(-1);
  assert.deepEqual([event.detail.outcome, event.detail.detail], [outcome, detail]);
  assert.equal(read.history.some(({ action, detail: recorded }) => action === 'approved'
    && recorded.challengeId === event.detail.challengeId), false);
}

const failingWrite = (code) => () => { throw Object.assign(new Error(`synthetic ${code}`), { code }); };

for (const code of ['ENOTDIR', 'EACCES']) {
  test(`a confirmed approval whose decision write fails (${code}) consumes its challenge and approves nothing`, async (t) => {
    const { service, reopen } = fixture(t);
    const app = await submitted(service);
    const context = reopen();
    const decisions = createConfirmedDecisions(context, {});
    const challenge = decisions.issueChallenge({ action: 'approve', ...approval(app) });
    const insertApproval = context.store.insertApproval;
    context.store.insertApproval = failingWrite(code);

    assert.throws(() => decisions.commitChallenge(challenge, typed(), CLI_USER), { code });

    const { store } = context;
    assert.deepEqual([store.app(app.appId).status, store.version(app.appId, '1.0.0').state,
      store.approval(app.appId, '1.0.0')], ['pending', 'pending', null]);
    assert.notEqual(store.challenge(app.appId).consumedAt, null);
    assert.throws(() => decisions.commitChallenge(challenge, typed(), CLI_USER), { code: 'challenge_replayed' });

    // The write works again; the same challenge and answer still cannot be committed.
    context.store.insertApproval = insertApproval;
    assert.throws(() => decisions.commitChallenge(challenge, typed(), CLI_USER), { code: 'challenge_replayed' });
    assertConsumedWithoutApproval(service, app.appId, { status: 'pending', version: null, outcome: 'decision_failed', detail: code });
    assert.equal(service.read({ appId: app.appId }).versions[0].approval, null);
  });
}

// A rival holding the same challenge and answer commits right after the
// failing commit claimed it (before it finalizes) or right after its finalize
// rolled back (before the failure is recorded). Neither rival may approve,
// and the challenge never reopens.
test('a rival commit racing a failed one at either step boundary never approves it', async (t) => {
  const { service, reopen } = fixture(t);
  for (const [boundary, name] of [[2, 'race-before-finalize'], [3, 'race-before-failure-record']]) {
    const app = await submitted(service, { name });
    const failingContext = reopen();
    failingContext.store.insertApproval = failingWrite('EACCES');
    const failing = createConfirmedDecisions(failingContext, {});
    const rival = createConfirmedDecisions(reopen(), {});
    const challenge = failing.issueChallenge({ action: 'approve', ...approval(app) });
    // Transactions of the failing commit: 1 claim, 2 finalize, 3 record the failure.
    const transaction = failingContext.store.transaction.bind(failingContext.store);
    const rivalOutcomes = [];
    let calls = 0;
    failingContext.store.transaction = (operation) => {
      calls += 1;
      if (calls === boundary) {
        try {
          rival.commitChallenge(challenge, typed(name), CLI_USER);
          rivalOutcomes.push('approved');
        } catch (error) {
          rivalOutcomes.push(error.code);
        }
      }
      return transaction(operation);
    };

    assert.throws(() => failing.commitChallenge(challenge, typed(name), CLI_USER), { code: 'EACCES' });

    assert.deepEqual([calls, rivalOutcomes], [3, ['challenge_replayed']], `boundary ${boundary}`);
    assertConsumedWithoutApproval(service, app.appId, { status: 'pending', version: null, outcome: 'decision_failed', detail: 'EACCES' });
    assert.equal(service.read({ appId: app.appId }).versions[0].approval, null);
    assert.throws(() => rival.commitChallenge(challenge, typed(name), CLI_USER), { code: 'challenge_replayed' });
  }
});

test('a confirmed rollback whose decision write fails keeps the running version', async (t) => {
  const { service, decisions, reopen, confirmation } = fixture(t);
  const first = await submitted(service);
  await decisions.approve(approval(first));
  const second = await submitted(service, { version: '1.0.1' });
  await decisions.approve(approval(second));
  const context = reopen();
  context.store.setApprovalCheck = failingWrite('EACCES');
  const failing = createConfirmedDecisions(context, { confirmation });

  await assert.rejects(failing.rollback({ appId: first.appId, version: '1.0.0', actor: CLI_USER }), { code: 'EACCES' });

  assertConsumedWithoutApproval(service, first.appId, { status: 'active', version: '1.0.1', outcome: 'decision_failed', detail: 'EACCES' });
  const read = service.read({ appId: first.appId });
  assert.equal(read.versions[0].approval.challengeId, read.history.find(({ action }) => action === 'approved').detail.challengeId,
    'the earlier approval of 1.0.0 is not rewritten');
  assert.equal(read.run.status, 'ready');
});

for (const [label, outcome] of [['null', null], ['undefined', undefined]]) {
  test(`a ${label} answer is a cancellation, consumed and never reusable`, async (t) => {
    const { service, decisions } = fixture(t);
    const app = await submitted(service);
    const challenge = decisions.issueChallenge({ action: 'approve', ...approval(app) });

    assert.throws(() => decisions.commitChallenge(challenge, outcome, CLI_USER), { code: 'confirmation_canceled' });
    assertConsumedWithoutApproval(service, app.appId, { status: 'pending', version: null, outcome: 'confirmation_canceled',
      detail: undefined });
    assert.throws(() => decisions.commitChallenge(challenge, typed(), CLI_USER), { code: 'challenge_replayed' });
  });
}

test('two processes consuming one nonce at once: exactly one approval wins', async (t) => {
  const { service, decisions, root } = fixture(t);
  const app = await submitted(service);
  const challenge = decisions.issueChallenge({ action: 'approve', ...approval(app) });
  const gate = new SharedArrayBuffer(4);
  const worker = () => new Worker(`
    const { workerData, parentPort } = require('node:worker_threads');
    (async () => {
      const { agentAppContext } = await import(workerData.service);
      const { createConfirmedDecisions } = await import(workerData.decisions);
      const context = agentAppContext({ root: workerData.root, toolNames: () => workerData.tools, clock: () => new Date(workerData.now),
        hostIdentity: { platform: 'test', self: async () => ({ pid: 1, identity: null, exePath: null }), probe: async () => 'unknown' } });
      void context.store.database;
      const decisions = createConfirmedDecisions(context, {});
      parentPort.postMessage('ready');
      Atomics.wait(new Int32Array(workerData.gate), 0, 0);
      try {
        decisions.commitChallenge(workerData.challenge, { typed: workerData.name }, { entrypoint: 'cli', user: 'fixture-user' });
        parentPort.postMessage('won');
      } catch (error) {
        parentPort.postMessage(error.code ?? error.message);
      } finally {
        context.store.close();
      }
    })();`, { eval: true, workerData: { gate, root, tools: TOOLS, challenge, name: NAME, now: FIXTURE_NOW,
    service: new URL('../src/agent-apps/service.js', import.meta.url).href,
    decisions: new URL('../src/agent-apps/confirmed-decisions.js', import.meta.url).href } });
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
  assert.deepEqual(consumed(service, app.appId), ['confirmed']);
  assert.equal(service.read({ appId: app.appId }).history.filter(({ action }) => action === 'approved').length, 1);
});

test('a console approval completes no confirmation, so the gate refuses it', async (t) => {
  const { service } = fixture(t);
  const app = await submitted(service);
  await service.approve({ ...approval(app), approver: CONSOLE });
  const read = service.read({ appId: app.appId });
  assert.equal(read.run.reason, 'confirmation_required');
  assert.match(read.run.message, /fuli app approve\/rollback/);
});

// Windows Hello on top of the terminal confirmation (--hello), never required.
test('an optional Windows Hello is asked after the typed name and recorded as presence hello', async (t) => {
  const { service, reopen, confirmation } = fixture(t, { answers: [NAME, 'dispatch-logs', NAME] });
  const verified = [];
  const hello = { kind: 'hello', verify: async (challenge) => { verified.push(challenge); return { verified: true }; } };
  const decisions = createConfirmedDecisions(reopen(), { confirmation, presence: hello });
  const app = await submitted(service);

  const approved = await decisions.approve(approval(app));
  assert.deepEqual([approved.approval.presence, approved.approval.verification, approved.approval.trustMode],
    ['hello', 'terminal_confirmation', 'trusted']);
  assert.equal(verified.length, 1);
  assert.doesNotMatch(verified[0].message, /这个应用会用你的账户权限/, 'the Hello dialog shows the short summary only');
  assert.equal(service.read({ appId: app.appId }).run.status, 'ready');

  // A wrong name is refused before any Hello dialog opens.
  const second = await submitted(service, { version: '1.0.1' });
  await assert.rejects(decisions.approve(approval(second)), { code: 'confirmation_mismatch' });
  assert.equal(verified.length, 1);

  // A Hello that was asked for and fails refuses the decision.
  const refusing = createConfirmedDecisions(reopen(), { confirmation,
    presence: { kind: 'hello', verify: async () => ({ verified: false, reason: 'presence_canceled', detail: 'hello_Canceled' }) } });
  await assert.rejects(refusing.approve(approval(second)), { code: 'presence_canceled' });
  const event = service.read({ appId: app.appId }).history.filter(({ action }) => action === 'challenge_consumed').at(-1);
  assert.deepEqual([event.detail.outcome, event.detail.detail], ['presence_canceled', 'hello_Canceled']);
  assert.equal(service.read({ appId: app.appId }).version, '1.0.0');
});

test('a Hello helper whose digest does not match refuses the decision it was asked for', async (t) => {
  const { service, reopen, confirmation } = fixture(t);
  const app = await submitted(service);
  const helper = fakeHelper({ answer: { stage: 'verification', result: 'Verified' } });
  const decisions = createConfirmedDecisions(reopen(),
    { confirmation, presence: windowsHello(t, { pinnedDigest: '0'.repeat(64), spawnHelper: helper.spawnHelper }) });

  await assert.rejects(decisions.approve(approval(app)), { code: 'presence_unavailable' });
  assert.equal(helper.runs.length, 0);
  assert.equal(service.read({ appId: app.appId }).status, 'pending');
  const event = service.read({ appId: app.appId }).history.find(({ action }) => action === 'challenge_consumed');
  assert.deepEqual([event.detail.outcome, event.detail.detail], ['presence_unavailable', 'helper_digest_mismatch']);
});

// rec#11 D-36.9: a registry a #304 FULI left (format 7), whose active version
// was approved with Windows Hello under the isolated mode. It migrates on its
// own (D-09), and the version is confirmed again before it runs.
test('an isolated-mode Windows Hello approval is not carried over to trusted mode', async (t) => {
  const { service, root, reopen, confirmation } = fixture(t);
  const app = await submitted(service);
  service.close();
  const registry = join(root, 'registry.sqlite');
  downgradeToHelloApproval(registry, app);

  const context = reopen();
  const upgraded = agentAppServiceOver(context);
  const read = upgraded.read({ appId: app.appId });
  assert.deepEqual([read.status, read.versions[0].approval.presence, read.versions[0].approval.verification,
    read.versions[0].approval.trustMode], ['active', 'hello', 'os_user_verified', null]);
  assert.equal(read.run.reason, 'reconfirmation_required');
  assert.match(read.run.message, /isolated mode[\s\S]*fuli app rollback[\s\S]*不会自动转为受信任模式/);
  const ledger = new DatabaseSync(registry, { readOnly: true });
  try {
    assert.equal(ledger.prepare('PRAGMA user_version').get().user_version, AGENT_APP_FORMAT.version);
    const step = ledger.prepare('SELECT status FROM fuli_format_ledger WHERE migration_id = ?').get('agent-apps/8-approval-trust-mode');
    assert.equal(step.status, 'applied');
  } finally {
    ledger.close();
  }

  // Confirming the same version again at the terminal is what lets it run.
  const confirmed = await createConfirmedDecisions(context, { confirmation })
    .rollback({ appId: app.appId, version: '1.0.0', actor: CLI_USER });
  assert.deepEqual([confirmed.approval.trustMode, confirmed.approval.presence], ['trusted', 'unverified']);
  assert.equal(upgraded.read({ appId: app.appId }).run.status, 'ready');
});

// Rewrites a fresh registry into what a #304 FULI left: format 7 (no trust
// columns), the version approved and active with a Windows Hello check whose
// challenge was consumed as verified.
function downgradeToHelloApproval(registry, { appId, digest }) {
  const at = '2026-10-20T08:00:00.000Z';
  const database = new DatabaseSync(registry);
  try {
    database.exec(`ALTER TABLE agent_app_approvals DROP COLUMN trust_mode;
      ALTER TABLE agent_app_approvals DROP COLUMN terms_version;
      PRAGMA user_version = 7;`);
    const manifest = JSON.parse(database.prepare('SELECT manifest FROM agent_app_versions WHERE app_id = ?').get(appId).manifest);
    database.prepare(`INSERT INTO agent_app_approvals (app_id, version, digest, permissions, data, resident, approved_by,
      entrypoint, presence, verification, challenge_id, verified_at, approved_at)
      VALUES (?, '1.0.0', ?, ?, ?, 0, 'fixture-user', 'cli', 'hello', 'os_user_verified', 'apc-hello', ?, ?)`)
      .run(appId, digest, JSON.stringify(manifest.permissions), JSON.stringify(manifest.data), at, at);
    database.prepare("UPDATE agent_app_versions SET state = 'approved' WHERE app_id = ?").run(appId);
    database.prepare("UPDATE agent_apps SET status = 'active', active_version = '1.0.0', data_format = 1 WHERE app_id = ?").run(appId);
    database.prepare(`INSERT INTO agent_app_events (app_id, at, action, version, actor, detail)
      VALUES (?, ?, 'challenge_consumed', '1.0.0', 'fixture-user', ?)`)
      .run(appId, at, JSON.stringify({ challengeId: 'apc-hello', decision: 'approve', outcome: 'verified' }));
  } finally {
    database.close();
  }
}

test('approvals written before any confirmation migrate, and the gate asks for a terminal confirmation', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-app-approval-legacy-'));
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
    .run(appId, 'http://127.0.0.1:65530', 'space-a', 'agent-jvs', NAME, 'active', '1.0.0', 1, at, at);
  legacy.prepare('INSERT INTO agent_app_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(appId, '1.0.0', 'approved', 'f'.repeat(64), JSON.stringify(manifest), 1, 32, at);
  legacy.prepare('INSERT INTO agent_app_approvals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(appId, '1.0.0', 'f'.repeat(64), JSON.stringify(manifest.permissions), JSON.stringify(manifest.data), 0,
      'fixture-user', 'cli', 'hello', at);
  legacy.close();

  // The identity keys of existing apps (rec#7 PR②) wait for a person's confirmation.
  const registry = join(root, 'registry.sqlite');
  assert.throws(() => agentAppServiceOver(agentAppContext({ root, toolNames: () => TOOLS, hostIdentity: HOST }))
    .read({ appId }), { code: 'data_format_pending' });
  const plan = previewSqliteMigration(registry, AGENT_APP_FORMAT);
  applyConfirmedSqliteMigration(registry, AGENT_APP_FORMAT, { digest: plan.digest, actor: { entrypoint: 'cli' } });
  const service = agentAppServiceOver(agentAppContext({ root, toolNames: () => TOOLS, hostIdentity: HOST }));
  t.after(() => {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const read = service.read({ appId });
  assert.deepEqual([read.versions[0].approval.presence, read.versions[0].approval.verification,
    read.versions[0].approval.challengeId, read.versions[0].approval.trustMode], ['hello', null, null, null]);
  assert.equal(read.run.reason, 'confirmation_required');
});
