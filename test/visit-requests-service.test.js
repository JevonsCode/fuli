import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { createVisitorAccess } from '../src/visitor-access/port.js';
import { createVisitRequests } from '../src/visit-requests/service.js';

// Synthetic requesters, projects and a fake runner: no Git, no client, no data directory.
const ALPHA = `peer:${'a'.repeat(64)}`;
const BETA = `peer:${'b'.repeat(64)}`;
const GUEST = 'guest:synthetic-link-1';
const PROJECT = 'synthetic-project';
const LEAD = 'synthetic-lead';
const SAFE_PLAN = { areas: ['src/server.js'], risks: [], dependencyChanges: false, configChanges: false, network: false, size: 's' };
const DRAFT = { title: 'Read the port from settings', what: 'The server should read its port from settings.json', expectedAreas: ['src/'] };

function fakeRunner({ plan = SAFE_PLAN, result = {}, holdRun = null } = {}) {
  const calls = { prepared: [], planned: [], ran: [], removed: [] };
  return {
    calls,
    async prepare(request) {
      calls.prepared.push(request.id);
      return { projectFolder: '/synthetic/project', worktreePath: `/synthetic/worktrees/${request.id}`,
        branch: `fuli/visit/${request.id}`, baseCommit: 'c'.repeat(40) };
    },
    async plan(request) { calls.planned.push(request.id); return { plan, error: plan ? null : 'plan_unreadable', ms: 1000 }; },
    async run(request, { signal }) {
      calls.ran.push({ id: request.id, decidedBy: request.decidedBy, mode: request.modeAtDecision });
      if (holdRun) {
        await Promise.race([holdRun, new Promise((_, reject) => signal.addEventListener('abort',
          () => reject(Object.assign(new Error('cancelled'), { code: 'cancelled', ms: 5 }))))]);
      }
      return { ms: 2000, summary: 'Changed the server to read its port.', intact: true, addedText: '+const port = settings.port;',
        files: [{ path: 'src/server.js', added: 3, removed: 1, binary: false, executable: false, symlink: false }],
        diffstat: { files: 1, added: 3, removed: 1 }, ...result };
    },
    async patch() { return { text: 'diff --git a/src/server.js b/src/server.js', truncated: false }; },
    async remove(request, { keepBranch }) { calls.removed.push({ id: request.id, keepBranch }); }
  };
}

function fixture(t, runnerOptions = {}, { now = () => new Date('2026-11-14T08:00:00.000Z') } = {}) {
  const runner = fakeRunner(runnerOptions);
  let sequence = 0;
  const port = createVisitorAccess({ application: {}, now,
    requests: ({ store, modeOf }) => createVisitRequests({ store, modeOf, runner, now, idFactory: () => `request-${++sequence}` }) });
  t.after(() => port.close());
  const submit = (key = ALPHA, request = DRAFT) => port.submitRequest({ requester: { key, label: 'Synthetic desk', agentName: 'Visitor lead' },
    projectId: PROJECT, agentId: LEAD, request });
  const setMode = (mode, key = ALPHA) => port.setRequesterMode({ key, kind: key.startsWith('peer:') ? 'peer' : 'guest',
    label: 'Synthetic desk', mode, ownDevice: mode === 'trusted' });
  const state = (id) => port.requests.card(id).then((card) => card.request.state);
  const events = async (id) => (await port.requests.card(id)).events.map((event) => [event.from, event.to, event.by]);
  return { port, runner, submit, setMode, state, events };
}

// Background planning and runs finish within a few event-loop turns.
async function settled(check) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await delay(5);
  }
  assert.fail('the request did not settle');
}

test('plan mode: a request is planned read-only, waits for the owner, runs once approved and ends kept', async (t) => {
  const f = fixture(t);
  const submitted = f.submit();
  assert.deepEqual(submitted, { ok: true, requestId: 'request-1', state: 'planning' });
  await settled(async () => await f.state('request-1') === 'awaiting_owner');
  assert.deepEqual(f.runner.calls.ran, [], 'nothing runs before the owner approves');
  const listed = f.port.requests.list();
  assert.equal(listed.awaiting.count, 1);
  assert.deepEqual(listed.awaiting.newest.map((request) => [request.id, request.plan.size, request.modeAtReceipt]), [['request-1', 's', 'plan']]);

  assert.equal(f.port.requests.approve('request-1').ok, true);
  await settled(async () => await f.state('request-1') === 'awaiting_review');
  const card = await f.port.requests.card('request-1');
  assert.deepEqual([card.request.review, card.request.decidedBy, card.request.modeAtDecision, card.request.runMs, card.request.planningMs],
    ['ready', 'owner', 'plan', 2000, 1000]);
  assert.equal(card.diff.text.startsWith('diff --git'), true, 'the owner reads the patch');

  assert.equal((await f.port.requests.keep('request-1')).ok, true);
  assert.deepEqual(f.runner.calls.removed, [{ id: 'request-1', keepBranch: true }], 'keep removes only the worktree');
  assert.deepEqual(await f.events('request-1'), [[null, 'received', 'requester'], ['received', 'planning', 'system'],
    ['planning', 'awaiting_owner', 'system'], ['awaiting_owner', 'approved', 'owner'], ['approved', 'running', 'system'],
    ['running', 'awaiting_review', 'rule'], ['awaiting_review', 'kept', 'owner']]);
  // A second decision on a finished request is a conflict, not a change.
  assert.deepEqual(await f.port.requests.discard('request-1'), { ok: false, code: 'state_conflict' });
  assert.deepEqual(await f.port.requests.keep('missing'), { ok: false, code: 'request_not_found' });
});

test('decline, discard, cancel and the 7-day expiry each end a request and tidy its worktree', async (t) => {
  let clock = new Date('2026-11-14T08:00:00.000Z');
  const f = fixture(t, {}, { now: () => clock });
  for (let index = 0; index < 3; index += 1) f.submit();
  await settled(async () => (await Promise.all(['request-1', 'request-2', 'request-3'].map(f.state))).every((s) => s === 'awaiting_owner'));
  const declined = await f.port.requests.decline('request-1', { reason: 'Not\u0007 now‮ please' });
  assert.deepEqual([declined.request.state, declined.request.reason], ['declined', 'Not now please']);
  assert.equal((await f.port.requests.cancel('request-2')).request.state, 'cancelled');
  clock = new Date('2026-11-21T08:00:01.000Z');
  assert.equal(await f.state('request-3'), 'expired');
  assert.deepEqual(f.runner.calls.removed.map((call) => [call.id, call.keepBranch]).sort(),
    [['request-1', false], ['request-2', false], ['request-3', false]]);

  clock = new Date('2026-11-21T09:00:00.000Z');
  f.submit();
  await settled(async () => await f.state('request-4') === 'awaiting_owner');
  f.port.requests.approve('request-4');
  await settled(async () => await f.state('request-4') === 'awaiting_review');
  assert.equal((await f.port.requests.discard('request-4')).request.state, 'discarded');
  assert.deepEqual(f.runner.calls.removed.at(-1), { id: 'request-4', keepBranch: false }, 'discard deletes the branch');
});

test('trusted skips only the approval; auto approves inside its envelope and sends the rest to the owner', async (t) => {
  const trusted = fixture(t);
  trusted.setMode('trusted');
  trusted.submit();
  await settled(async () => await trusted.state('request-1') === 'awaiting_review');
  assert.deepEqual(trusted.runner.calls.ran, [{ id: 'request-1', decidedBy: 'rule', mode: 'trusted' }]);
  assert.equal((await trusted.port.requests.card('request-1')).request.review, 'ready');

  const auto = fixture(t);
  auto.setMode('auto');
  auto.submit();
  await settled(async () => await auto.state('request-1') === 'awaiting_review');
  const approved = (await auto.port.requests.card('request-1')).events.find((event) => event.to === 'approved');
  assert.deepEqual([approved.by, approved.rule, approved.checks.every((check) => check.ok)], ['rule', 'auto_envelope_v1', true]);

  // A plan that declares a dependency change stays a card for the owner.
  const risky = fixture(t, { plan: { ...SAFE_PLAN, dependencyChanges: true } });
  risky.setMode('auto');
  risky.submit();
  await settled(async () => await risky.state('request-1') === 'awaiting_owner');
  const held = (await risky.port.requests.card('request-1')).events.at(-1);
  assert.deepEqual([held.by, held.rule, held.checks.find((check) => check.name === 'no_dependency_changes').ok], ['rule', 'auto_envelope_v1', false]);
  assert.deepEqual(risky.runner.calls.ran, []);

  // Without a readable plan the owner decides, and can still approve.
  const unplanned = fixture(t, { plan: null });
  unplanned.setMode('auto');
  unplanned.submit();
  await settled(async () => await unplanned.state('request-1') === 'awaiting_owner');
  assert.equal((await unplanned.port.requests.card('request-1')).request.planError, 'plan_unreadable');
});

test('auto: a run whose diff leaves the envelope is held, and the requester only hears it waits for the owner', async (t) => {
  const f = fixture(t, { result: { files: [{ path: 'package-lock.json', added: 2, removed: 2, binary: false, executable: false, symlink: false }] } });
  f.setMode('auto');
  f.submit();
  await settled(async () => await f.state('request-1') === 'awaiting_review');
  const card = await f.port.requests.card('request-1');
  assert.deepEqual([card.request.review, card.request.holdReason], ['held', 'outside_envelope']);
  assert.deepEqual(f.port.requestStatus({ requester: { key: ALPHA }, requestId: 'request-1' }),
    { ok: true, requestId: 'request-1', state: 'awaiting_owner', title: DRAFT.title });
});

test('a secret in the summary or the added lines holds the result in every mode, and its summary never leaves', async (t) => {
  const f = fixture(t, { result: { addedText: `+const key = "sk-synthetic${'Q'.repeat(24)}";` } });
  f.setMode('trusted');
  f.submit();
  await settled(async () => await f.state('request-1') === 'awaiting_review');
  const { request } = await f.port.requests.card('request-1');
  assert.deepEqual([request.review, request.holdReason, request.summary], ['held', 'secret_found', null]);
  await f.port.requests.keep('request-1');
  const status = f.port.requestStatus({ requester: { key: ALPHA }, requestId: 'request-1' });
  assert.equal(status.state, 'kept');
  assert.equal(Object.hasOwn(status, 'summary'), false);
});

test('a broken integrity snapshot holds the result for the owner', async (t) => {
  const f = fixture(t, { result: { intact: false } });
  f.setMode('trusted');
  f.submit();
  await settled(async () => await f.state('request-1') === 'awaiting_review');
  assert.equal((await f.port.requests.card('request-1')).request.holdReason, 'integrity_violation');
});

test('ask_only, a guest link and an exhausted budget are refused before any wake, and recorded', async (t) => {
  const f = fixture(t);
  f.setMode('ask_only');
  assert.deepEqual(f.submit(), { ok: false, code: 'ask_only' });
  assert.deepEqual(f.submit(GUEST), { ok: false, code: 'ask_only' }, 'a guest link stays ask_only');
  assert.deepEqual(f.runner.calls.prepared, [], 'no worktree, no wake');
  const refusedRows = f.port.requests.list({ state: 'refused' }).requests;
  assert.deepEqual(refusedRows.map((row) => [row.requesterKey, row.reason, row.modeAtReceipt]),
    [[GUEST, 'ask_only', 'ask_only'], [ALPHA, 'ask_only', 'ask_only']]);

  f.setMode('plan', BETA);
  for (let index = 0; index < 5; index += 1) assert.equal(f.submit(BETA).ok, true);
  assert.deepEqual(f.submit(BETA), { ok: false, code: 'budget_exceeded' }, 'five a day for a paired device');
  await settled(async () => f.runner.calls.planned.length === 5);
  assert.equal(f.runner.calls.prepared.length, 5, 'the sixth woke nothing');
  assert.deepEqual(f.submit(BETA, { title: 'x'.repeat(161), what: 'y' }), { ok: false, code: 'request_invalid' });
});

test('the wake minutes of a day are a budget too', async (t) => {
  const f = fixture(t, { result: { ms: 61 * 60 * 1000 } });
  f.setMode('trusted');
  f.submit();
  await settled(async () => await f.state('request-1') === 'awaiting_review');
  assert.deepEqual(f.submit(), { ok: false, code: 'budget_exceeded' });
});

test('lowering a mode to ask_only cancels open requests, running ones through their signal, in one change', async (t) => {
  let release;
  const f = fixture(t, { holdRun: new Promise((resolve) => { release = resolve; }) });
  t.after(() => release());
  f.setMode('trusted');
  f.submit();
  await settled(async () => await f.state('request-1') === 'running');
  f.setMode('plan');
  f.submit();
  await settled(async () => await f.state('request-2') === 'awaiting_owner');
  const changed = f.setMode('ask_only');
  assert.deepEqual([changed.effects.cancelled.sort(), changed.effects.returned], [['request-1', 'request-2'], []]);
  assert.deepEqual([await f.state('request-1'), await f.state('request-2')], ['cancelled', 'cancelled']);
  await settled(async () => f.runner.calls.removed.length === 2);
  const running = (await f.port.requests.card('request-1')).events.at(-1);
  assert.deepEqual([running.from, running.to, running.by, running.note], ['running', 'cancelled', 'owner', 'mode_ask_only']);
});

test('lowering to plan returns rule-approved requests that have not started; raising approves nothing waiting', async (t) => {
  let release;
  const f = fixture(t, { holdRun: new Promise((resolve) => { release = resolve; }) });
  t.after(() => release());
  f.setMode('trusted');
  f.submit();
  f.submit();
  // One lane per lead: the first runs, the second waits approved by the rule.
  await settled(async () => await f.state('request-1') === 'running' && await f.state('request-2') === 'approved');
  const changed = f.setMode('plan');
  assert.deepEqual(changed.effects, { cancelled: [], returned: ['request-2'] });
  assert.equal(await f.state('request-2'), 'awaiting_owner');
  assert.equal(await f.state('request-1'), 'running', 'a running request continues; it is isolated and never merged');
  f.setMode('trusted');
  assert.equal(await f.state('request-2'), 'awaiting_owner', 'raising the mode approves nothing retroactively');
  const returned = (await f.port.requests.card('request-2')).request;
  assert.deepEqual([returned.decidedBy, returned.modeAtDecision], [null, null]);
});

test('revoking the paired device cancels its open requests and no other device\'s', async (t) => {
  const f = fixture(t);
  f.submit(ALPHA);
  f.submit(BETA);
  await settled(async () => await f.state('request-1') === 'awaiting_owner' && await f.state('request-2') === 'awaiting_owner');
  const effects = await f.port.requesterRevoked(ALPHA);
  assert.deepEqual(effects.cancelled, ['request-1']);
  assert.deepEqual([await f.state('request-1'), await f.state('request-2')], ['cancelled', 'awaiting_owner']);
  assert.equal((await f.port.requests.card('request-1')).events.at(-1).note, 'requester_revoked');
});

test('only the device that made a request reads it, and only summary, branch, files and diffstat cross', async (t) => {
  const f = fixture(t);
  f.setMode('trusted');
  f.submit(ALPHA);
  await settled(async () => await f.state('request-1') === 'awaiting_review');
  assert.deepEqual(f.port.requestStatus({ requester: { key: BETA }, requestId: 'request-1' }), { ok: false, code: 'request_not_found' });
  assert.deepEqual(f.port.requestStatus({ requester: { key: ALPHA }, requestId: 'request-9' }), { ok: false, code: 'request_not_found' });
  const status = f.port.requestStatus({ requester: { key: ALPHA }, requestId: 'request-1' });
  assert.deepEqual(status, { ok: true, requestId: 'request-1', state: 'awaiting_review', title: DRAFT.title,
    summary: 'Changed the server to read its port.', branch: 'fuli/visit/request-1', files: ['src/server.js'],
    diffstat: { files: 1, added: 3, removed: 1 } });
});

test('after a restart a run that was going is unknown, a plan that was going waits for the owner, approved work runs', async (t) => {
  const runner = fakeRunner({ holdRun: new Promise(() => {}) });
  const now = () => new Date('2026-11-14T08:00:00.000Z');
  let sequence = 0;
  const shared = { store: null };
  const port = createVisitorAccess({ application: {}, now, requests: ({ store, modeOf }) => {
    shared.store = store;
    return createVisitRequests({ store, modeOf, runner, now, idFactory: () => `request-${++sequence}` });
  } });
  t.after(() => port.close());
  port.setRequesterMode({ key: ALPHA, kind: 'peer', label: 'Desk', mode: 'trusted', ownDevice: true });
  port.submitRequest({ requester: { key: ALPHA, label: 'Desk' }, projectId: PROJECT, agentId: LEAD, request: DRAFT });
  await settled(async () => (await port.requests.card('request-1')).request.state === 'running');
  // A second service over the same store stands for the console after a restart.
  const restarted = createVisitRequests({ store: shared.store, modeOf: () => 'plan', runner: fakeRunner(), now });
  restarted.resume();
  assert.equal((await restarted.card('request-1')).request.state, 'unknown');
  await restarted.close();
});
