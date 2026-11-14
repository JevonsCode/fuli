import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { createVisitorAccess } from '../src/visitor-access/port.js';
import { createVisitRequests } from '../src/visit-requests/service.js';

// Synthetic requesters, projects and a fake runner: no Git, no client, no data directory.
const ALPHA = `peer:${'a'.repeat(64)}`;
const BETA = `peer:${'b'.repeat(64)}`;
const GAMMA = `peer:${'c'.repeat(64)}`;
const GUEST = 'guest:synthetic-link-1';
const PROJECT = 'synthetic-project';
const LEAD = 'synthetic-lead';
const SAFE_PLAN = { areas: ['src/server.js'], risks: [], dependencyChanges: false, configChanges: false, network: false, size: 's' };
const DRAFT = { title: 'Read the port from settings', what: 'The server should read its port from settings.json', expectedAreas: ['src/'] };

function fakeRunner({ plan = SAFE_PLAN, result = {}, holdRun = null, afterAbort = null } = {}) {
  const calls = { folders: [], prepared: [], planned: [], ran: [], removed: [] };
  return {
    calls,
    async folder(request) { calls.folders.push(request.id); return '/synthetic/project'; },
    async prepare(request) {
      calls.prepared.push(request.id);
      return { projectFolder: '/synthetic/project', worktreePath: `/synthetic/worktrees/${request.id}`,
        branch: `fuli/visit/${request.id}`, baseCommit: 'c'.repeat(40) };
    },
    planned: (request) => ({ worktreePath: `/synthetic/worktrees/${request.id}`, branch: `fuli/visit/${request.id}` }),
    async plan(request, { client }) { calls.planned.push({ id: request.id, cwd: request.projectFolder, worktree: request.worktreePath, client });
      return { plan, error: plan ? null : 'plan_unreadable', ms: 1000 }; },
    async run(request, { signal, client, lead }) {
      calls.ran.push({ id: request.id, decidedBy: request.decidedBy, mode: request.modeAtDecision, client, lead });
      if (holdRun) {
        await Promise.race([holdRun, new Promise((_, reject) => signal.addEventListener('abort', async () => {
          // A commit step still finishing after the abort.
          if (afterAbort) await afterAbort();
          reject(Object.assign(new Error('cancelled'), { code: 'cancelled', ms: 5 }));
        }))]);
      }
      return { ms: 2000, hold: null, summary: 'Changed the server to read its port.', intact: true, addedText: '+const port = settings.port;',
        files: [{ path: 'src/server.js', added: 3, removed: 1, binary: false, executable: false, symlink: false }],
        diffstat: { files: 1, added: 3, removed: 1 }, ...result };
    },
    async patch() { return { text: 'diff --git a/src/server.js b/src/server.js', truncated: false }; },
    async remove(request, { keepBranch }) { calls.removed.push({ id: request.id, keepBranch }); }
  };
}

function fixture(t, runnerOptions = {}, { now = () => new Date('2026-11-14T08:00:00.000Z'), lead = LEAD, clients = ['claude_code'],
  platform = 'linux' } = {}) {
  const runner = fakeRunner(runnerOptions);
  const leads = { current: lead, confirm: async ({ agentId }) => agentId === leads.current, constrainedClients: async () => clients,
    describe: async () => ({ name: 'Synthetic lead', responsibility: 'Owns the server' }) };
  let sequence = 0;
  const port = createVisitorAccess({ application: {}, now,
    requests: ({ store, modeOf }) => createVisitRequests({ store, modeOf, runner, leads, platform, now,
      idFactory: () => `request-${++sequence}` }) });
  t.after(() => port.close());
  const submit = (key = ALPHA, request = DRAFT, projectId = PROJECT) => port.submitRequest({
    requester: { key, label: 'Synthetic desk', agentName: 'Visitor lead' }, projectId, agentId: LEAD, request });
  const setMode = (mode, key = ALPHA) => port.setRequesterMode({ key, kind: key.startsWith('peer:') ? 'peer' : 'guest',
    label: 'Synthetic desk', mode, ownDevice: mode === 'trusted' });
  const state = (id) => port.requests.card(id).then((card) => card.request.state);
  const events = async (id) => (await port.requests.card(id)).events.map((event) => [event.from, event.to, event.by]);
  return { port, runner, leads, submit, setMode, state, events };
}

// Background planning and runs finish within a few event-loop turns.
async function settled(check) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await delay(5);
  }
  assert.fail('the request did not settle');
}

test('plan mode: planned read-only in the project folder, no worktree before approval, runs once approved, ends kept', async (t) => {
  const f = fixture(t);
  const submitted = f.submit();
  assert.deepEqual(submitted, { ok: true, requestId: 'request-1', state: 'planning' });
  await settled(async () => await f.state('request-1') === 'awaiting_owner');
  assert.deepEqual(f.runner.calls.planned, [{ id: 'request-1', cwd: '/synthetic/project', worktree: null, client: 'claude_code' }]);
  assert.deepEqual([f.runner.calls.prepared, f.runner.calls.ran], [[], []], 'no worktree and no run before the owner approves');
  const listed = f.port.requests.list();
  assert.equal(listed.awaiting.count, 1);
  assert.deepEqual(listed.awaiting.newest.map((request) => [request.id, request.plan.size, request.modeAtReceipt]), [['request-1', 's', 'plan']]);

  assert.equal(f.port.requests.approve('request-1').ok, true);
  await settled(async () => await f.state('request-1') === 'awaiting_review');
  assert.deepEqual(f.runner.calls.prepared, ['request-1'], 'the worktree is made after the approval');
  const card = await f.port.requests.card('request-1');
  assert.deepEqual([card.request.review, card.request.decidedBy, card.request.modeAtDecision, card.request.runMs, card.request.planningMs],
    ['ready', 'owner', 'plan', 2000, 1000]);
  assert.equal(card.diff.text.startsWith('diff --git'), true, 'the owner reads the patch');

  assert.equal((await f.port.requests.keep('request-1')).ok, true);
  assert.deepEqual(f.runner.calls.removed, [{ id: 'request-1', keepBranch: true }], 'keep removes only the worktree');
  assert.deepEqual(await f.events('request-1'), [[null, 'received', 'requester'], ['received', 'planning', 'system'],
    ['planning', 'awaiting_owner', 'system'], ['awaiting_owner', 'approved', 'owner'], ['approved', 'running', 'system'],
    ['running', 'awaiting_review', 'rule'], ['awaiting_review', 'kept', 'owner']]);
  assert.deepEqual(await f.port.requests.discard('request-1'), { ok: false, code: 'state_conflict' });
  assert.deepEqual(await f.port.requests.keep('missing'), { ok: false, code: 'request_not_found' });
});

test('decline, cancel and the 7-day expiry end a waiting request; discard removes a result\'s worktree and branch', async (t) => {
  let clock = new Date('2026-11-14T08:00:00.000Z');
  const f = fixture(t, {}, { now: () => clock });
  f.submit();
  f.submit(BETA);
  await settled(async () => await f.state('request-1') === 'awaiting_owner' && await f.state('request-2') === 'awaiting_owner');
  f.submit(GAMMA);
  await settled(async () => await f.state('request-3') === 'awaiting_owner');
  const declined = await f.port.requests.decline('request-1', { reason: 'Not\u0007 now‮ please' });
  assert.deepEqual([declined.request.state, declined.request.reason], ['declined', 'Not now please']);
  assert.equal((await f.port.requests.cancel('request-2')).request.state, 'cancelled');
  clock = new Date('2026-11-21T08:00:01.000Z');
  assert.equal(await f.state('request-3'), 'expired');
  assert.deepEqual(f.runner.calls.removed, [], 'nothing was copied, so nothing to remove');

  clock = new Date('2026-11-21T09:00:00.000Z');
  f.submit();
  await settled(async () => await f.state('request-4') === 'awaiting_owner');
  f.port.requests.approve('request-4');
  await settled(async () => await f.state('request-4') === 'awaiting_review');
  assert.equal((await f.port.requests.discard('request-4')).request.state, 'discarded');
  assert.deepEqual(f.runner.calls.removed.at(-1), { id: 'request-4', keepBranch: false }, 'discard deletes the branch');
});

test('a result left unreviewed for 14 days expires: its worktree goes, its branch stays, and it counted as open meanwhile', async (t) => {
  let clock = new Date('2026-11-01T08:00:00.000Z');
  const f = fixture(t, {}, { now: () => clock });
  f.setMode('trusted');
  f.submit();
  await settled(async () => await f.state('request-1') === 'awaiting_review');
  clock = new Date('2026-11-15T08:00:01.000Z');
  assert.equal(await f.state('request-1'), 'expired');
  await settled(async () => f.runner.calls.removed.length === 1);
  assert.deepEqual(f.runner.calls.removed, [{ id: 'request-1', keepBranch: true }]);
  assert.equal((await f.port.requests.card('request-1')).events.at(-1).note, 'review_expired');
});

test('trusted skips only the approval; auto approves inside its envelope; both run constrained as the lead', async (t) => {
  const trusted = fixture(t);
  trusted.setMode('trusted');
  trusted.submit();
  await settled(async () => await trusted.state('request-1') === 'awaiting_review');
  assert.deepEqual(trusted.runner.calls.ran, [{ id: 'request-1', decidedBy: 'rule', mode: 'trusted', client: 'claude_code',
    lead: { name: 'Synthetic lead', responsibility: 'Owns the server' } }]);
  assert.deepEqual(trusted.runner.calls.planned[0].client, 'claude_code');

  const auto = fixture(t);
  auto.setMode('auto');
  auto.submit();
  await settled(async () => await auto.state('request-1') === 'awaiting_review');
  const approved = (await auto.port.requests.card('request-1')).events.find((event) => event.to === 'approved');
  assert.deepEqual([approved.by, approved.rule, approved.checks.every((check) => check.ok)], ['rule', 'auto_envelope_v1', true]);

  // A lead whose clients FULI cannot run constrained (only Codex, for now): nothing could run it, said plainly.
  const codexOnly = fixture(t, {}, { clients: [] });
  codexOnly.setMode('trusted');
  codexOnly.submit();
  await settled(async () => await codexOnly.state('request-1') === 'failed');
  const failed = (await codexOnly.port.requests.card('request-1')).request;
  assert.deepEqual([failed.error, failed.reason], ['no_constrained_client', 'no_constrained_client']);
  assert.deepEqual([codexOnly.runner.calls.planned, codexOnly.runner.calls.folders], [[], []], 'no wake, no folder read');

  const risky = fixture(t, { plan: { ...SAFE_PLAN, dependencyChanges: true } });
  risky.setMode('auto');
  risky.submit();
  await settled(async () => await risky.state('request-1') === 'awaiting_owner');
  const held = (await risky.port.requests.card('request-1')).events.at(-1);
  assert.deepEqual([held.by, held.rule, held.checks.find((check) => check.name === 'no_dependency_changes').ok], ['rule', 'auto_envelope_v1', false]);
  assert.deepEqual(risky.runner.calls.ran, []);

  const unplanned = fixture(t, { plan: null });
  unplanned.setMode('auto');
  unplanned.submit();
  await settled(async () => await unplanned.state('request-1') === 'awaiting_owner');
  assert.equal((await unplanned.port.requests.card('request-1')).request.planError, 'plan_unreadable');
});

test('auto: a run whose diff leaves the envelope is held, and the requester only hears it waits for the owner', async (t) => {
  const f = fixture(t, { result: { files: [{ path: '.vscode/tasks.json', added: 2, removed: 0 }] } });
  f.setMode('auto');
  f.submit();
  await settled(async () => await f.state('request-1') === 'awaiting_review');
  const card = await f.port.requests.card('request-1');
  assert.deepEqual([card.request.review, card.request.holdReason], ['held', 'outside_envelope']);
  assert.deepEqual(f.port.requestStatus({ requester: { key: ALPHA }, requestId: 'request-1' }),
    { ok: true, requestId: 'request-1', state: 'awaiting_owner', title: DRAFT.title });
});

test('unsafe content, a too large run, a secret or a broken integrity snapshot hold the result in every mode', async (t) => {
  for (const [result, reason] of [[{ hold: 'unsafe_content', files: [] }, 'unsafe_content'], [{ hold: 'too_large', files: [] }, 'too_large'],
    [{ addedText: `+const key = "sk-synthetic${'Q'.repeat(24)}";` }, 'secret_found'], [{ intact: false }, 'integrity_violation']]) {
    const f = fixture(t, { result });
    f.setMode('trusted');
    f.submit();
    await settled(async () => await f.state('request-1') === 'awaiting_review');
    const { request } = await f.port.requests.card('request-1');
    assert.deepEqual([request.review, request.holdReason], ['held', reason], reason);
    // A held result never shows the requester anything of the work, even once kept.
    await f.port.requests.keep('request-1');
    assert.deepEqual(f.port.requestStatus({ requester: { key: ALPHA }, requestId: 'request-1' }),
      { ok: true, requestId: 'request-1', state: 'kept', title: DRAFT.title }, reason);
  }
});

test('ask_only, a guest link and an exhausted budget are refused before any wake, and recorded', async (t) => {
  const f = fixture(t);
  f.setMode('ask_only');
  assert.deepEqual(f.submit(), { ok: false, code: 'ask_only' });
  assert.deepEqual(f.submit(GUEST), { ok: false, code: 'ask_only' }, 'a guest link stays ask_only');
  assert.deepEqual(f.runner.calls.folders, [], 'no folder read, no wake');
  const refusedRows = f.port.requests.list({ state: 'refused' }).requests;
  assert.deepEqual(refusedRows.map((row) => [row.requesterKey, row.reason, row.modeAtReceipt]).sort(),
    [[GUEST, 'ask_only', 'ask_only'], [ALPHA, 'ask_only', 'ask_only']]);

  for (let index = 0; index < 5; index += 1) {
    assert.equal(f.submit(BETA).ok, true);
    await settled(async () => f.runner.calls.planned.length === index + 1 && f.port.requests.list({ state: 'planning' }).requests.length === 0);
  }
  assert.deepEqual(f.submit(BETA), { ok: false, code: 'budget_exceeded' }, 'five a day for a paired device');
  assert.equal(f.runner.calls.planned.length, 5, 'the sixth woke nothing');
  assert.deepEqual(f.submit(BETA, { title: 'x'.repeat(161), what: 'y' }), { ok: false, code: 'request_invalid' });
});

test('per project, per computer and planning at once are limits too, in the same transaction as the request', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture(t);
  // Two planning wakes at once at most.
  const slowPlan = f.runner.plan;
  f.runner.plan = async (request) => { await gate; return slowPlan(request); };
  assert.equal(f.submit(ALPHA).ok, true);
  assert.equal(f.submit(BETA).ok, true);
  assert.deepEqual(f.submit(GAMMA), { ok: false, code: 'planning_busy' });
  release();
  await settled(async () => f.port.requests.list({ state: 'planning' }).requests.length === 0);

  // Ten a day for one project, from any requesters.
  const keys = Array.from({ length: 13 }, (_, index) => `peer:${String(index + 1).padStart(64, '0')}`);
  for (const key of keys.slice(0, 8)) {
    assert.equal(f.submit(key).ok, true, key);
    await settled(async () => f.port.requests.list({ state: 'planning' }).requests.length === 0);
  }
  assert.deepEqual(f.submit(keys[8]), { ok: false, code: 'project_budget_exceeded' });
  // Twenty a day for this computer, over every project.
  for (let index = 0; index < 10; index += 1) {
    assert.equal(f.submit(keys[9 + (index % 4)], DRAFT, `other-project-${index}`).ok, true, String(index));
    await settled(async () => f.port.requests.list({ state: 'planning' }).requests.length === 0);
  }
  assert.deepEqual(f.submit(keys[12], DRAFT, 'one-more-project'), { ok: false, code: 'computer_budget_exceeded' });
});

test('the wake minutes of a day are a budget too', async (t) => {
  const f = fixture(t, { result: { ms: 61 * 60 * 1000 } });
  f.setMode('trusted');
  f.submit();
  await settled(async () => await f.state('request-1') === 'awaiting_review');
  assert.deepEqual(f.submit(), { ok: false, code: 'budget_exceeded' });
});

test('lowering a mode to ask_only cancels open requests; a running one is tidied only after its run ended', async (t) => {
  let release;
  const order = [];
  const f = fixture(t, { holdRun: new Promise((resolve) => { release = resolve; }),
    afterAbort: async () => { await delay(30); order.push('commit_step_ended'); } });
  t.after(() => release());
  const remove = f.runner.remove;
  f.runner.remove = async (request, options) => { order.push(`removed:${request.id}`); return remove(request, options); };
  f.setMode('trusted');
  f.submit();
  await settled(async () => await f.state('request-1') === 'running');
  f.setMode('plan');
  f.submit();
  await settled(async () => await f.state('request-2') === 'awaiting_owner');
  const changed = f.setMode('ask_only');
  assert.deepEqual([changed.effects.cancelled.sort(), changed.effects.returned], [['request-1', 'request-2'], []]);
  assert.deepEqual([await f.state('request-1'), await f.state('request-2')], ['cancelled', 'cancelled']);
  await settled(async () => order.includes('removed:request-1'));
  assert.deepEqual(order, ['commit_step_ended', 'removed:request-1'], 'no worktree removed under a commit');
  const running = (await f.port.requests.card('request-1')).events.at(-1);
  assert.deepEqual([running.from, running.to, running.by, running.note], ['running', 'cancelled', 'owner', 'mode_ask_only']);
});

test('the owner\'s cancel of a running request also waits for the run to end before tidying', async (t) => {
  let release;
  const order = [];
  const f = fixture(t, { holdRun: new Promise((resolve) => { release = resolve; }),
    afterAbort: async () => { await delay(30); order.push('commit_step_ended'); } });
  t.after(() => release());
  const remove = f.runner.remove;
  f.runner.remove = async (request, options) => { order.push('removed'); return remove(request, options); };
  f.setMode('trusted');
  f.submit();
  await settled(async () => await f.state('request-1') === 'running');
  const cancelled = await f.port.requests.cancel('request-1');
  assert.equal(cancelled.request.state, 'cancelled');
  assert.deepEqual(order, ['commit_step_ended', 'removed']);
});

test('lowering to plan returns rule-approved requests that have not started; raising approves nothing waiting', async (t) => {
  let release;
  const f = fixture(t, { holdRun: new Promise((resolve) => { release = resolve; }) });
  t.after(() => release());
  f.setMode('trusted');
  f.submit();
  await settled(async () => await f.state('request-1') === 'running');
  f.submit();
  // One lane per lead: the first runs, the second waits approved by the rule.
  await settled(async () => await f.state('request-2') === 'approved');
  const changed = f.setMode('plan');
  assert.deepEqual(changed.effects, { cancelled: [], returned: ['request-2'] });
  assert.equal(await f.state('request-2'), 'awaiting_owner');
  assert.equal(await f.state('request-1'), 'running', 'a running request continues; it is isolated and never merged');
  f.setMode('trusted');
  assert.equal(await f.state('request-2'), 'awaiting_owner', 'raising the mode approves nothing retroactively');
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

test('removing a share ends that project\'s open requests; a lead change cancels an approved request before it runs', async (t) => {
  const f = fixture(t);
  f.submit(ALPHA);
  f.submit(BETA, DRAFT, 'kept-project');
  await settled(async () => await f.state('request-1') === 'awaiting_owner' && await f.state('request-2') === 'awaiting_owner');
  const effects = await f.port.requests.sharesChanged([{ projectId: 'kept-project', agentId: LEAD }]);
  assert.deepEqual(effects.cancelled, ['request-1']);
  const card = (await f.port.requests.card('request-1')).request;
  assert.deepEqual([card.state, card.reason], ['cancelled', 'share_removed']);
  assert.equal(await f.state('request-2'), 'awaiting_owner');

  f.leads.current = 'someone-else';
  f.port.requests.approve('request-2');
  await settled(async () => await f.state('request-2') === 'cancelled');
  assert.equal((await f.port.requests.card('request-2')).request.reason, 'lead_changed');
  assert.deepEqual(f.runner.calls.prepared, [], 'nothing was copied or run');
});

test('a requester sees a plan-mode result only once the owner kept it, and a trusted one when ready; never the patch', async (t) => {
  const f = fixture(t, { result: { files: Array.from({ length: 60 }, (_, index) => ({ path: `src/${'x'.repeat(250)}\u0007${index}.js`,
    added: 1, removed: 0 })), diffstat: { files: 60, added: 60, removed: 0 } } });
  f.submit(ALPHA);
  await settled(async () => await f.state('request-1') === 'awaiting_owner');
  f.port.requests.approve('request-1');
  await settled(async () => await f.state('request-1') === 'awaiting_review');
  assert.deepEqual(f.port.requestStatus({ requester: { key: ALPHA }, requestId: 'request-1' }),
    { ok: true, requestId: 'request-1', state: 'awaiting_owner', title: DRAFT.title }, 'reads like any request waiting for the owner');
  await f.port.requests.keep('request-1');
  const kept = f.port.requestStatus({ requester: { key: ALPHA }, requestId: 'request-1' });
  assert.deepEqual(Object.keys(kept), ['ok', 'requestId', 'state', 'title', 'summary', 'branch', 'files', 'diffstat']);
  assert.equal(kept.files.length, 50, 'at most 50 paths');
  assert.ok(kept.files.every((path) => path.length <= 200 && !path.includes('\u0007')));
  assert.deepEqual(f.port.requestStatus({ requester: { key: BETA }, requestId: 'request-1' }), { ok: false, code: 'request_not_found' });

  f.setMode('trusted', BETA);
  f.submit(BETA);
  await settled(async () => await f.state('request-2') === 'awaiting_review');
  const trusted = f.port.requestStatus({ requester: { key: BETA }, requestId: 'request-2' });
  assert.deepEqual([trusted.state, trusted.branch, trusted.summary], ['awaiting_review', 'fuli/visit/request-2',
    'Changed the server to read its port.']);
});

test('a status read is rate limited and writes nothing', async (t) => {
  const f = fixture(t);
  f.submit(ALPHA);
  await settled(async () => await f.state('request-1') === 'awaiting_owner');
  const before = JSON.stringify(f.port.requests.list());
  for (let index = 0; index < 5; index += 1) f.port.requestStatus({ requester: { key: ALPHA }, requestId: 'request-1' });
  assert.equal(JSON.stringify(f.port.requests.list()), before);
  assert.deepEqual(f.port.recentReads().reads, [], 'no visitor read row either');
});

test('after a restart a run that was going is unknown and its worktree goes; approved work runs', async (t) => {
  const runner = fakeRunner({ holdRun: new Promise(() => {}) });
  const now = () => new Date('2026-11-14T08:00:00.000Z');
  const leads = { confirm: async () => true, constrainedClients: async () => ['claude_code'], describe: async () => null };
  let sequence = 0;
  const shared = { store: null };
  const port = createVisitorAccess({ application: {}, now, requests: ({ store, modeOf }) => {
    shared.store = store;
    return createVisitRequests({ store, modeOf, runner, leads, now, idFactory: () => `request-${++sequence}` });
  } });
  t.after(() => port.close());
  port.setRequesterMode({ key: ALPHA, kind: 'peer', label: 'Desk', mode: 'trusted', ownDevice: true });
  port.submitRequest({ requester: { key: ALPHA, label: 'Desk' }, projectId: PROJECT, agentId: LEAD, request: DRAFT });
  await settled(async () => (await port.requests.card('request-1')).request.state === 'running');
  // A second service over the same store stands for the console after a restart.
  const fresh = fakeRunner();
  const restarted = createVisitRequests({ store: shared.store, modeOf: () => 'plan', runner: fresh, leads, now });
  restarted.resume();
  assert.equal((await restarted.card('request-1')).request.state, 'unknown');
  await settled(async () => fresh.calls.removed.length === 1);
  assert.deepEqual(fresh.calls.removed, [{ id: 'request-1', keepBranch: false }]);
  await restarted.close();
});

test('a restart between making the worktree and recording it still tidies both: the paths are recorded first', async (t) => {
  const runner = fakeRunner();
  // The worktree step is still going when the restart happens.
  runner.prepare = () => new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('late'), { code: 'git_failed' })), 300));
  const now = () => new Date('2026-11-14T08:00:00.000Z');
  const leads = { confirm: async () => true, constrainedClients: async () => ['claude_code'], describe: async () => null };
  const shared = { store: null };
  const port = createVisitorAccess({ application: {}, now, requests: ({ store, modeOf }) => {
    shared.store = store;
    return createVisitRequests({ store, modeOf, runner, leads, now, idFactory: () => 'request-1' });
  } });
  t.after(() => port.close());
  port.setRequesterMode({ key: ALPHA, kind: 'peer', label: 'Desk', mode: 'trusted', ownDevice: true });
  port.submitRequest({ requester: { key: ALPHA, label: 'Desk' }, projectId: PROJECT, agentId: LEAD, request: DRAFT });
  await settled(async () => (await port.requests.card('request-1')).request.state === 'running');
  const fresh = fakeRunner();
  const removed = [];
  fresh.remove = async (request) => { removed.push([request.worktreePath, request.branch]); };
  const restarted = createVisitRequests({ store: shared.store, modeOf: () => 'plan', runner: fresh, leads, now });
  restarted.resume();
  await settled(async () => removed.length === 1);
  assert.deepEqual(removed, [['/synthetic/worktrees/request-1', 'fuli/visit/request-1']]);
  await restarted.close();
});

test('status reads are counted without writing: past 60 in ten minutes a requester is refused', async (t) => {
  const f = fixture(t);
  f.submit(ALPHA);
  await settled(async () => await f.state('request-1') === 'awaiting_owner');
  for (let index = 0; index < 60; index += 1) assert.equal(f.port.requestStatus({ requester: { key: ALPHA }, requestId: 'request-1' }).ok, true);
  assert.deepEqual(f.port.requestStatus({ requester: { key: ALPHA }, requestId: 'request-1' }), { ok: false, code: 'rate_limited_short' });
  assert.equal(f.port.requestStatus({ requester: { key: BETA }, requestId: 'request-1' }).code, 'request_not_found', 'others are not affected');
  assert.deepEqual(f.port.recentReads().reads, []);
});
