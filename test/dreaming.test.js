import assert from 'node:assert/strict';
import test from 'node:test';

import { DREAMING_OPERATION, dreamingReadiness, dreamProject } from '../src/dreaming/run.js';

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
