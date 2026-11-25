import assert from 'node:assert/strict';
import test from 'node:test';

import { localAnswer } from '../src/runner/local-answer-note.js';
import { ownerRecruitmentState, queueOwnerRecruitments, recruitmentState } from '../src/runner/owner-recruitments.js';
import { RunnerStore } from '../src/runner/runner-store.js';
import { jsonAnswer } from '../test-support/paired-follower.js';

// Recruitments of a project this computer owns, for FLAs the host makes
// (owner-recruitments.js). Synthetic records only.
const HOST = { name: 'Host A', fingerprint: 'a'.repeat(64), certPem: 'synthetic', port: 2730, addresses: ['192.0.2.20'] };

function recruitment(id, overrides = {}) {
  return { recruitment_id: id, proposed_agent_id: `agent-${id}`, status: 'blocked', reason_code: 'recruitment_on_owner',
    reason: 'The project needs a lead', personal_project_id: 'widgets',
    proposed_profile: { name: `Lead ${id}`, responsibility: 'Lead the project' },
    occupation: { role: 'engineering', tags: ['testing'] }, ...overrides };
}

function application(recruitments) {
  return { config: { personal: { spaceId: 'space-synthetic' } }, personal: {
    listProjectAgentRecruitments: async ({ status }) => recruitments.filter((one) => !status || one.status === status),
    listPersonalProjects: async () => [{ project_id: 'widgets', profile: { name: 'Widgets' } }] } };
}

test('each recruitment waiting for the host is one recruit op under an id its recruitment decides, queued once', async () => {
  const store = new RunnerStore(':memory:');
  store.saveHost(HOST);
  const app = application([recruitment('r-1', { task_id: 'task-1', trigger_source_application: 'cursor',
    proposed_profile: { name: 'Lead r-1', responsibility: 'Lead the project', agent_type: 'temporary' } }), recruitment('r-2'), recruitment('r-3', { status: 'fulfilled' }),
    recruitment('r-4', { reason_code: 'hr_unavailable' })]);
  const first = await queueOwnerRecruitments({ app, store, sourceApplication: 'codex', sessionId: 'session-1' });
  assert.equal(first.queued, 2, 'only those blocked on the owner');
  assert.deepEqual(first.waiting.map(({ personalProjectId }) => personalProjectId), ['widgets', 'widgets']);
  const entry = store.entry(first.waiting[0].id);
  assert.equal(entry.tool, 'global_writes');
  assert.deepEqual(entry.input.ops, [{ kind: 'recruit', v: 1, input: { recruitmentId: 'r-1', proposedAgentId: 'agent-r-1',
    taskId: 'task-1', recruitmentSourceApplication: 'cursor',
    profile: { name: 'Lead r-1', responsibility: 'Lead the project', agent_type: 'temporary' }, occupation: { role: 'engineering', tags: ['testing'] },
    reason: 'The project needs a lead', projectName: 'Widgets' } }]);
  const again = await queueOwnerRecruitments({ app, store, sourceApplication: 'codex', sessionId: 'session-1' });
  assert.equal(again.queued, 0);
  assert.deepEqual(again.waiting, first.waiting);
  assert.equal(store.outbox().queued, 2);
  store.close();
});

test('a recruitment no host could make is named, not sent', async () => {
  const store = new RunnerStore(':memory:');
  store.saveHost(HOST);
  const app = application([recruitment('r-5', { reason: '' }), recruitment('r-6', { occupation: null }),
    recruitment('x'.repeat(129)), recruitment('r-7')]);
  const said = await queueOwnerRecruitments({ app, store, sourceApplication: 'codex', sessionId: null });
  assert.equal(said.queued, 1);
  assert.deepEqual(said.unsent, ['r-5', 'r-6', 'x'.repeat(129)]);
  store.close();
});

test('a reason and a project name longer than the host reads are cut here, not refused there for good', async () => {
  const store = new RunnerStore(':memory:');
  store.saveHost(HOST);
  const app = application([recruitment('r-9', { reason: 'r'.repeat(2500) })]);
  app.personal.listPersonalProjects = async () => [{ project_id: 'widgets', name: 'n'.repeat(300) }];
  const { waiting } = await queueOwnerRecruitments({ app, store, sourceApplication: 'codex', sessionId: null });
  const { input } = store.entry(waiting[0].id).input.ops[0];
  assert.equal(input.reason.length, 2000);
  assert.equal(input.projectName.length, 200);
  store.close();
});

test('the entry\'s note says the recruitment waits, online, offline, and when the host refused it', async () => {
  const entry = jsonAnswer({ taskContextToken: 't', context: { personal_project_id: 'widgets' } });
  const note = (recruitment, hostOnline) => localAnswer('get_collaboration_preferences', entry,
    { hostName: 'Host A', syncedAt: null, queuedForHost: 0, recruitment, hostOnline }).structuredContent.runner.message;
  assert.match(note({ queued: 1, refused: [] }, true), /Host A was asked to make one[\s\S]*已请 Host A 建一位/);
  assert.match(note({ queued: 1, refused: [] }, false), /Host A is away[\s\S]*连上后自动完成/);
  const refusedNote = note({ queued: 0, refused: ['agent_name_taken'] }, true);
  assert.match(refusedNote, /did not make[\s\S]*name is taken[\s\S]*同名[\s\S]*取消这次招聘再招一次/);
  assert.doesNotMatch(refusedNote, /agent_name_taken/, 'the code is said in words');

  const store = new RunnerStore(':memory:');
  store.saveHost(HOST);
  const { waiting } = await queueOwnerRecruitments({ app: application([recruitment('r-8')]), store, sourceApplication: 'codex' });
  assert.deepEqual(recruitmentState(store, waiting.map(({ id }) => id)), { queued: 1, refused: [] });
  assert.equal(recruitmentState(store, []), null);
  store.close();
});

test('a previously queued request checks the recruitment and the task again before delivery', async () => {
  const row = recruitment('waiting', { task_id: 't' });
  let taskStatus = 'cancelled';
  const provider = { listProjectAgentRecruitments: async () => [row],
    viewProjectAgentTask: async () => ({ task_id: 't', status: taskStatus }) };
  const check = () => ownerRecruitmentState(provider, 'space', { recruitmentId: 'waiting',
    proposedAgentId: row.proposed_agent_id, taskId: 't' });
  assert.equal(await check(), 'withdrawn');
  taskStatus = 'awaiting_recruitment';
  assert.equal(await check(), 'waiting');
  row.status = 'cancelled';
  assert.equal(await check(), 'withdrawn');
  provider.listProjectAgentRecruitments = async () => [];
  assert.equal(await check(), 'withdrawn');
  provider.listProjectAgentRecruitments = async () => ({});
  assert.equal(await check(), 'unknown');
});
