import assert from 'node:assert/strict';
import test from 'node:test';

import { DREAMING_OPERATION, dreamingReadiness, dreamProject } from '../src/dreaming/run.js';
import { dreamingRuns, startDreamingScheduler } from '../src/dreaming/scheduler.js';

const SPACE = 'space-synthetic';
const PROJECT = 'project-synthetic';
const egress = { allowUnassigned: false, approvedProjects: [{ personalSpaceId: SPACE, personalProjectId: PROJECT }] };

function fixture({ proposals = [], decision = 'propose', settings = { egress }, allows = true, turns = 2, envelope } = {}) {
  const calls = { requests: [], captured: [], revised: [], rows: [] };
  const app = {
    config: { personal: { spaceId: SPACE } },
    modelBackends: {
      operationSettings: (role, operation) => (role === 'assistant' && operation === DREAMING_OPERATION ? settings : null),
      allowsEgress: () => allows,
      decide: async (request) => {
        calls.requests.push(request);
        return { envelope: envelope === undefined ? { decision, payload: { proposals } } : envelope, modelReceipt: { status: 'answered', actualModel: 'synthetic' } };
      }
    },
    personal: {
      getProjectAgentCoordinationPolicy: async () => ({ team_lead_agent_id: 'lead-1', project_manager_agent_id: null }),
      listProjectAgents: async () => [{ agent_id: 'lead-1', profile: { name: 'Synthetic lead' }, assignments: [{ personal_project_id: PROJECT, status: 'active' }] }],
      recentAgentSessions: async () => [1, 2, 3].map(n => ({ source_application: 'codex', session_id: `s${n}`, last_active: `2026-11-0${n}T00:00:00Z` }))
    },
    roleSuggestions: { record: row => calls.rows.push(row), list: () => [] },
    captureSessionKnowledge: async (input) => { calls.captured.push(input); return { route: 'personal' }; },
    reviseKnowledgeItem: async (input) => { calls.revised.push(input); return {}; }
  };
  const ownerReads = { sessionRecords: async ({ session_id: id }) => ({
    turns: turns ? [{ personal_project_id: PROJECT, messages: [{ role: 'user', text: `Synthetic words of ${id}` }] },
      { personal_project_id: 'another-project', messages: [{ role: 'user', text: 'Words of another project' }] }] : [],
    items: [{ id: 'item-old', item_kind: 'entity', title: 'Old fact', summary: 'Synthetic old fact' }] }) };
  return { app, ownerReads, calls };
}

const add = (sessions, extra = {}) => ({ action: 'add', title: 'Synthetic rule', text: 'Synthetic rule text', itemId: null, itemKind: null, sessions, personCorrected: false, ...extra });

test('rec#89: Dreaming needs a connected model; without one nothing is read or sent', async () => {
  const { app, ownerReads, calls } = fixture({ settings: null });
  assert.equal(dreamingReadiness(app, PROJECT), 'needs_model');
  assert.deepEqual(await dreamProject(app, ownerReads, { personalProjectId: PROJECT }), { status: 'needs_model' });
  assert.deepEqual(calls.requests, []);
  assert.deepEqual(calls.rows, []);
});

test('rec#89: a project the person did not approve is never read', async () => {
  const { app, ownerReads, calls } = fixture({ settings: { egress: { allowUnassigned: false, approvedProjects: [] } } });
  assert.deepEqual(await dreamProject(app, ownerReads, { personalProjectId: PROJECT }), { status: 'project_not_approved' });
  assert.deepEqual(calls.requests, []);
});

test('rec#89: a pattern across sessions lands pending in the queue, and only this project\'s words were sent', async () => {
  const { app, ownerReads, calls } = fixture({ proposals: [add(['session_1', 'session_2', 'session_3'])] });
  const result = await dreamProject(app, ownerReads, { personalProjectId: PROJECT, now: new Date('2026-11-05T00:00:00Z') });
  assert.equal(result.status, 'dreamed');
  assert.deepEqual(result.proposed.map(({ status, seenIn }) => [status, seenIn]), [['queued', 3]]);
  const [entity] = calls.captured[0].entities;
  assert.equal(entity.confirmationStatus, 'pending', 'a proposal never lands confirmed');
  assert.equal(calls.captured[0].personalProjectId, PROJECT);
  const sent = JSON.stringify(calls.requests[0].evidence);
  assert.match(sent, /Synthetic words of s1/);
  assert.doesNotMatch(sent, /Words of another project/);
  assert.ok(calls.requests[0].evidence.every(item => item.personalProjectId === PROJECT));
  assert.equal(calls.rows.length, 1);
  assert.doesNotMatch(JSON.stringify(calls.rows[0].result), /Synthetic rule/, 'the log keeps no words a permanent delete could miss');
});

test('rec#89: too few sessions, invented sessions and unknown items are dropped', async () => {
  const { app, ownerReads, calls } = fixture({ proposals: [add(['session_1']), add(['session_1', 'session_2', 'session_99']),
    { ...add(['session_1', 'session_2', 'session_3']), action: 'retire', itemId: 'item-never-shown', itemKind: 'entity' }] });
  const result = await dreamProject(app, ownerReads, { personalProjectId: PROJECT });
  assert.deepEqual(result.proposed, []);
  assert.deepEqual(calls.captured, []);
  assert.deepEqual(calls.revised, []);
});

test('rec#89: a person\'s plain correction counts from one session', async () => {
  const { app, ownerReads, calls } = fixture({ proposals: [add(['session_2'], { personCorrected: true })] });
  await dreamProject(app, ownerReads, { personalProjectId: PROJECT });
  assert.equal(calls.captured.length, 1);
});

test('rec#89: a stale item is reported to the person by an Agent, not ended', async () => {
  const { app, ownerReads, calls } = fixture({ proposals: [{ ...add(['session_1', 'session_2', 'session_3']), action: 'retire', itemId: 'item-old', itemKind: 'relationship' }] });
  const result = await dreamProject(app, ownerReads, { personalProjectId: PROJECT });
  assert.equal(calls.revised[0].action, 'mark_outdated');
  assert.equal(calls.revised[0].operationActor, 'agent');
  assert.equal(calls.revised[0].itemKind, 'entity', 'the kind comes from what the session showed, not the model');
  assert.equal(result.proposed[0].status, 'queued');
});

test('rec#89: a permission taken back during the run applies nothing', async () => {
  const { app, ownerReads, calls } = fixture({ allows: false, proposals: [add(['session_1', 'session_2', 'session_3'])] });
  const result = await dreamProject(app, ownerReads, { personalProjectId: PROJECT });
  assert.equal(result.status, 'superseded');
  assert.deepEqual(calls.captured, []);
});

test('rec#89: no words to read and a failed model say so and change nothing', async () => {
  const empty = fixture({ turns: 0 });
  assert.equal((await dreamProject(empty.app, empty.ownerReads, { personalProjectId: PROJECT })).status, 'nothing_to_read');
  assert.deepEqual(empty.calls.requests, []);
  const failed = fixture({ envelope: null });
  assert.equal((await dreamProject(failed.app, failed.ownerReads, { personalProjectId: PROJECT })).status, 'model_failed');
  assert.deepEqual(failed.calls.captured, []);
});

test('rec#89: runs are read through the refreshing read, and a closed log never loses the run', async () => {
  const { app, ownerReads, calls } = fixture({ proposals: [add(['session_1', 'session_2', 'session_3'])] });
  app.readRoleSuggestions = async () => [{ operation: DREAMING_OPERATION, at: '2026-11-05T00:00:00Z' }, { operation: 'project_candidate', at: '2026-11-05T00:00:00Z' }];
  assert.deepEqual((await dreamingRuns(app)).map(row => row.operation), [DREAMING_OPERATION]);

  app.roleSuggestions.record = () => { throw new Error('recovery gate closed'); };
  const result = await dreamProject(app, ownerReads, { personalProjectId: PROJECT });
  assert.equal(result.status, 'dreamed');
  assert.equal(result.recorded, false);
  assert.equal(calls.captured.length, 1);
});

test('rec#89: every word is read, across several calls, and the merge can\'t invent a session', async () => {
  const { app, ownerReads, calls } = fixture();
  ownerReads.sessionRecords = async ({ session_id: id }) => ({ items: [],
    turns: [{ personal_project_id: PROJECT, messages: Array.from({ length: 30 }, (_, n) => ({ role: 'user', text: `${id}-${n} ${'x'.repeat(5000)}` })) }] });
  app.modelBackends.decide = async (request) => {
    calls.requests.push(request);
    const merging = request.evidence[0].id.startsWith('proposal_');
    const proposals = merging ? [add(['proposal_1', 'proposal_2', 'proposal_3'])]
      : calls.requests.length <= 3 ? [add([request.evidence[0].id])] : [];
    return { envelope: { decision: 'propose', payload: { proposals } }, modelReceipt: { status: 'completed', usage: { totalTokens: 10 } } };
  };
  const result = await dreamProject(app, ownerReads, { personalProjectId: PROJECT });
  const sent = calls.requests.flatMap(request => request.evidence).map(item => item.text).join('');
  for (const id of ['s1', 's2', 's3']) for (const n of [0, 29]) assert.match(sent, new RegExp(`${id}-${n} `));
  assert.ok(calls.requests.length > 2, 'more than one call');
  assert.ok(calls.requests.every(request => request.evidence.every(item => item.text.length <= 20_000)));
  assert.equal(result.usage.calls, calls.requests.length);
  assert.equal(result.status, 'dreamed');
});

test('rec#89: a later run reads only what was said since the last one', async () => {
  const { app, ownerReads, calls } = fixture();
  ownerReads.sessionRecords = async () => ({ items: [], turns: [{ personal_project_id: PROJECT, messages: [
    { role: 'user', text: 'Synthetic old words', created_at: '2026-11-01T00:00:00Z' }, { role: 'user', text: 'Synthetic new words', created_at: '2026-11-03T00:00:00Z' }] }] });
  await dreamProject(app, ownerReads, { personalProjectId: PROJECT, since: '2026-11-02T00:00:00Z' });
  const sent = JSON.stringify(calls.requests[0].evidence);
  assert.match(sent, /Synthetic new words/);
  assert.doesNotMatch(sent, /Synthetic old words/);
});

function longProject(fixed) {
  fixed.ownerReads.sessionRecords = async ({ session_id: id }) => ({ items: [],
    turns: [{ personal_project_id: PROJECT, messages: Array.from({ length: 30 }, (_, n) => ({ role: 'user', text: `${id}-${n} ${'x'.repeat(5000)}` })) }] });
  return fixed;
}

test('rec#89: a reply that won\'t validate costs its own part, and the run goes on', async () => {
  const { app, ownerReads, calls } = longProject(fixture());
  let first = true;
  app.modelBackends.decide = async (request) => {
    calls.requests.push(request);
    if (first) {
      first = false;
      return { envelope: null, modelReceipt: { status: 'failed', reason: 'invalid_output', usage: { totalTokens: 5 } } };
    }
    const merging = request.evidence[0].id.startsWith('proposal_');
    return { envelope: { decision: merging ? 'no_change' : 'propose', payload: { proposals: merging ? [] : [add(['session_1', 'session_2', 'session_3'])] } },
      modelReceipt: { status: 'completed', usage: { totalTokens: 5 } } };
  };
  const result = await dreamProject(app, ownerReads, { personalProjectId: PROJECT });
  assert.equal(result.status, 'dreamed');
  assert.equal(result.unread, 0, 'the failed part was read again in halves');
  const firstBatch = calls.requests[0].evidence.map(item => item.id);
  assert.deepEqual(calls.requests[1].evidence.map(item => item.id), firstBatch.slice(0, Math.ceil(firstBatch.length / 2)));
});

test('rec#89: a part that can\'t be read is counted, and the others still count', async () => {
  const { app, ownerReads, calls } = longProject(fixture());
  let n = 0;
  app.modelBackends.decide = async (request) => {
    calls.requests.push(request);
    n += 1;
    if (n === 1) return { envelope: null, modelReceipt: { status: 'failed', reason: 'network', usage: {} } };
    return { envelope: { decision: 'propose', payload: { proposals: request.evidence[0].id.startsWith('proposal_') ? [] : [add(['session_1', 'session_2', 'session_3'])] } },
      modelReceipt: { status: 'completed', usage: { totalTokens: 5 } } };
  };
  const result = await dreamProject(app, ownerReads, { personalProjectId: PROJECT });
  assert.equal(result.status, 'dreamed');
  assert.ok(result.unread > 0);
});

test('rec#89: a lesson in three parts of one long session counts, and the page says how many candidates there were', async () => {
  const { app, ownerReads } = longProject(fixture({ proposals: [add(['session_1_part_1', 'session_1_part_3', 'session_1_part_5'])] }));
  const result = await dreamProject(app, ownerReads, { personalProjectId: PROJECT, now: new Date('2026-11-05T00:00:00Z') });
  assert.equal(result.status, 'dreamed');
  assert.ok(result.candidates >= 1);
  assert.deepEqual(result.proposed.map(({ status, seenIn }) => [status, seenIn]), [['queued', 1]]);
});

test('rec#89: two citations of one part are one place', async () => {
  const { app, ownerReads, calls } = longProject(fixture({ proposals: [add(['session_1_part_1', 'session_1_part_1', 'session_1_part_2'])] }));
  await dreamProject(app, ownerReads, { personalProjectId: PROJECT });
  assert.deepEqual(calls.captured, []);
});

test('rec#89: more candidates than one call holds still merge, and a merge that fails keeps them to the same bar', async () => {
  const { app, ownerReads, calls } = longProject(fixture());
  const many = Array.from({ length: 80 }, (_, n) => add(['session_1', 'session_2', 'session_3'], { title: `Synthetic rule ${n}` }));
  let reads = 0;
  app.modelBackends.decide = async (request) => {
    calls.requests.push(request);
    if (request.evidence[0].id.startsWith('proposals_')) return { envelope: null, modelReceipt: { status: 'failed', reason: 'network', usage: {} } };
    reads += 1;
    return { envelope: { decision: 'propose', payload: { proposals: reads === 1 ? many : [] } }, modelReceipt: { status: 'completed', usage: { totalTokens: 5 } } };
  };
  const result = await dreamProject(app, ownerReads, { personalProjectId: PROJECT });
  const merging = calls.requests.filter(request => request.evidence[0].id.startsWith('proposals_'));
  assert.ok(merging.length >= 1 && merging.every(request => request.evidence.length <= 64));
  assert.equal(result.candidates, 80);
  assert.equal(result.proposed.length, 80);
  assert.ok(result.unread >= 1, 'a failed merge reads again next time');
});

test('rec#89: a run outlasts the recovery proof, so it is checked again before the row is written', async () => {
  const { app, ownerReads, calls } = fixture({ proposals: [add(['session_1', 'session_2', 'session_3'])] });
  let open = false;
  app.knowledgeRecoveryGate = { refresh: async () => { open = true; } };
  const record = app.roleSuggestions.record;
  app.roleSuggestions.record = (row) => { if (!open) throw new Error('recovery gate closed'); record(row); };
  const result = await dreamProject(app, ownerReads, { personalProjectId: PROJECT });
  assert.equal(result.recorded, undefined);
  assert.equal(calls.rows.length, 1);
});

test('rec#89: a run whose row could not be written is not run again on the next tick', async () => {
  const { app, ownerReads, calls } = fixture({ proposals: [add(['session_1', 'session_2', 'session_3'])] });
  app.roleSuggestions.record = () => { throw new Error('recovery gate closed'); };
  app.readRoleSuggestions = async () => [];
  app.listPersonalProjects = async () => [{ project_id: PROJECT, scope_type: 'project' }];
  const stop = startDreamingScheduler({ app, ownerReads, intervalMs: 5 });
  await new Promise(resolve => { setTimeout(resolve, 80); });
  await stop();
  assert.equal(calls.requests.length, 1);
});

