import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { callAgentTool } from '../src/agent-tools.js';
import { agentInterfaceCatalog } from '../src/agent-tools/interface-catalog.js';
import { createFuliRoundtableHost } from '../src/graphiti/roundtable-host.js';
import { registerStandingAssignment } from '../src/graphiti/standing-assignment-entry.js';
import { withStandingOwner } from '../src/graphiti/task-entry-standing-owner.js';
import { mapHttpError } from '../src/http/error-mapping.js';
import { handleStandingAssignmentRequest } from '../src/http/standing-assignment-api-router.js';
import { createStandingAssignments } from '../src/standing-assignments/port.js';

// rec#29 F5: the person corrects or ends a standing assignment, in a
// conversation (preview, their yes, confirm) or in the local console (at the
// revision it showed). Synthetic Provider boundary and a temporary store only;
// no real data, client or model.

const SPACE = 'space-synthetic';
const TOKEN = 'fuli-task-synthetic';
const REPO = { status: 'matched', basis: 'repository_root', personalProjectId: 'repo-a' };
const PROMPT = '帮我填一下今天的工时';

function application(t, { activityOrigin = null, delegated = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-standing-correction-'));
  const standingAssignments = createStandingAssignments({ path: join(directory, 'standing-assignments.sqlite') });
  t.after(() => { standingAssignments.close(); rmSync(directory, { recursive: true, force: true }); });
  const projects = ['repo-a', 'timesheet', 'ops'].map(id => ({ project_id: id, scope_type: 'registered',
    profile: { name: id === 'timesheet' ? 'Timesheet' : id } }));
  const policy = new Map([['timesheet', 'lead-timesheet'], ['ops', 'lead-ops']]);
  const team = { timesheet: ['lead-timesheet', 'helper-timesheet'], ops: ['lead-ops'], 'repo-a': [] };
  const writes = [];
  const app = {
    config: { personal: { spaceId: SPACE } }, standingAssignments, policy, writes,
    taskContextRegistry: { context: async (token) => {
      if (token !== TOKEN) throw Object.assign(new Error('Unknown task context'), { status: 404 });
      return { token, sessionId: 'session-synthetic', activityOrigin };
    } },
    roundtable: { taskEntryDelegation: () => (delegated ? { token: 'delegation' } : null) },
    upsertPersonalProject: async input => writes.push(['project', input]),
    personal: {
      listPersonalProjects: async () => projects,
      getPersonalProject: async (_, id) => projects.find(project => project.project_id === id),
      getProjectAgentCoordinationPolicy: async (_, id) => ({ team_lead_agent_id: policy.get(id) ?? null }),
      getProjectAgent: async (_, __, agentId) => ({ agent_id: agentId, profile: { name: `${agentId} name` } }),
      listProjectAgents: async (_, projectId) => (team[projectId] ?? []).map(agentId => ({ agent_id: agentId,
        profile: { name: `${agentId} name`, status: 'active' },
        assignments: [{ personal_project_id: projectId, status: 'active' }] })),
      staffDefaultProjectLead: async input => writes.push(['staff', input]),
      updateProjectAgentCoordinationPolicy: async input => writes.push(['policy', input])
    }
  };
  app.registerStandingAssignment = input => registerStandingAssignment(app, input);
  const { assignment } = standingAssignments.register({ personalSpaceId: SPACE, projectId: 'timesheet',
    leadAgentId: 'lead-timesheet', terms: ['iDev', '工时'], responsibility: 'Fill the synthetic timesheet',
    source: 'user', sourceConversationId: 'session-register' });
  return { app, assignment };
}

const correct = (app, action, change, input = {}) => callAgentTool(app, 'register_standing_assignment',
  { action, change, taskContextToken: TOKEN, term: '工时', ...input });

async function confirmed(app, change, input = {}) {
  const { confirmationDigest } = await correct(app, 'preview', change, input);
  return correct(app, 'confirm', change, { ...input, confirmationDigest });
}

const routedProject = async app => (await withStandingOwner(app, REPO, { taskPrompt: PROMPT })).personalProjectId;
const foundLeads = async (app, query = '工时') => (await createFuliRoundtableHost(app).matchWork(query))
  .map(({ agentId, projectId }) => [projectId, agentId]);
const changes = (app, assignmentId) => app.standingAssignments.history(assignmentId)
  .map(({ change, source, sourceConversationId }) => [change, source, sourceConversationId]);

test('a preview restates the correction in one sentence and writes nothing', async (t) => {
  const { app, assignment } = application(t);
  const preview = await correct(app, 'preview', 'retire');
  assert.equal(preview.status, 'preview');
  assert.equal(preview.executed, false);
  assert.equal(preview.restatement, 'FULI will stop sending later tasks that mention "iDev", "工时" to project '
    + '"Timesheet" (lead "lead-timesheet name"); its history is kept and nothing is done now.');
  assert.match(preview.confirmationDigest, /^[0-9a-f]{64}$/);
  assert.match(preview.guidance, /Nothing was saved\. Ask the user once/);
  for (const [change, input] of [['reassign', { projectName: 'ops' }], ['edit_terms', { addTerms: ['报工'] }]]) {
    assert.equal((await correct(app, 'preview', change, input)).status, 'preview', change);
  }
  assert.deepEqual(app.standingAssignments.list(SPACE), [assignment]);
  assert.equal(app.standingAssignments.history(assignment.assignmentId).length, 1);
  assert.deepEqual(app.writes, []);
});

test('retiring frees the terms, keeps the history and stops routing and find_agents', async (t) => {
  const { app, assignment } = application(t);
  assert.equal(await routedProject(app), 'timesheet');
  const done = await confirmed(app, 'retire');
  assert.equal(done.status, 'retired');
  assert.equal(done.executed, false);
  assert.ok(done.assignment.retiredAt);
  assert.deepEqual(app.standingAssignments.list(SPACE), []);
  assert.deepEqual(changes(app, assignment.assignmentId),
    [['registered', 'user', 'session-register'], ['retired', 'user', 'session-synthetic']]);
  assert.equal(await routedProject(app), 'repo-a');
  assert.deepEqual(await foundLeads(app), []);
  // The freed term can name another assignment.
  assert.equal(app.standingAssignments.register({ personalSpaceId: SPACE, projectId: 'ops', leadAgentId: 'lead-ops',
    terms: ['工时'], responsibility: 'Synthetic ops work', source: 'user' }).status, 'created');
  await assert.rejects(correct(app, 'preview', 'retire', { term: 'iDev' }), { status: 404 });
});

test('a stale or foreign digest is refused and nothing is written', async (t) => {
  const { app, assignment } = application(t);
  const { confirmationDigest } = await correct(app, 'preview', 'edit_terms', { addTerms: ['报工'] });
  await assert.rejects(correct(app, 'confirm', 'edit_terms', { addTerms: ['加班'], confirmationDigest }),
    { code: 'standing_assignment_plan_changed' });
  await assert.rejects(correct(app, 'confirm', 'retire', { confirmationDigest }), { code: 'standing_assignment_plan_changed' });
  // The assignment changes after the preview (another conversation adds a term).
  app.standingAssignments.register({ personalSpaceId: SPACE, projectId: 'timesheet', leadAgentId: 'lead-timesheet',
    terms: ['工时表'], responsibility: 'Fill the synthetic timesheet', source: 'user' });
  await assert.rejects(correct(app, 'confirm', 'edit_terms', { addTerms: ['报工'], confirmationDigest }),
    { code: 'standing_assignment_plan_changed' });
  await assert.rejects(correct(app, 'confirm', 'edit_terms', { addTerms: ['报工'] }), /confirmationDigest is required/);
  assert.deepEqual(app.standingAssignments.history(assignment.assignmentId).map(({ change }) => change),
    ['registered', 'extended']);
});

test('reassigning to an Agent of another project is refused; a valid lead moves routing and find_agents', async (t) => {
  const { app, assignment } = application(t);
  await assert.rejects(correct(app, 'preview', 'reassign', { projectName: 'ops', leadAgentId: 'helper-timesheet' }),
    { code: 'standing_assignment_lead_not_in_project', status: 422 });
  await assert.rejects(correct(app, 'preview', 'reassign', { projectName: 'nowhere' }), { status: 404 });
  await assert.rejects(correct(app, 'preview', 'reassign', {}), { code: 'standing_assignment_unchanged' });

  // Another Agent of the same project.
  const helper = await confirmed(app, 'reassign', { leadAgentId: 'helper-timesheet' });
  assert.deepEqual([helper.status, helper.assignment.projectId, helper.assignment.leadAgentId],
    ['reassigned', 'timesheet', 'helper-timesheet']);
  assert.deepEqual(await foundLeads(app), [['timesheet', 'helper-timesheet']]);

  // Another project and its lead; the terms move with it.
  const preview = await correct(app, 'preview', 'reassign', { projectName: 'ops' });
  assert.equal(preview.restatement, 'FULI will send later tasks that mention "iDev", "工时" to project "ops" (lead '
    + '"lead-ops name") instead of project "Timesheet" (lead "helper-timesheet name"); nothing is done now.');
  const ops = await correct(app, 'confirm', 'reassign', { projectName: 'ops',
    confirmationDigest: preview.confirmationDigest });
  assert.deepEqual([ops.assignment.projectId, ops.assignment.leadAgentId, ops.assignment.terms],
    ['ops', 'lead-ops', ['iDev', '工时']]);
  assert.equal(await routedProject(app), 'ops');
  assert.deepEqual(await foundLeads(app), [['ops', 'lead-ops']]);
  assert.deepEqual(changes(app, assignment.assignmentId), [['registered', 'user', 'session-register'],
    ['reassigned', 'user', 'session-synthetic'], ['reassigned', 'user', 'session-synthetic']]);
  // Neither project's own lead changed.
  assert.deepEqual([...app.policy], [['timesheet', 'lead-timesheet'], ['ops', 'lead-ops']]);
  assert.deepEqual(app.writes, []);
});

test('editing terms adds and removes them under the one-term-one-assignment rule', async (t) => {
  const { app, assignment } = application(t);
  app.standingAssignments.register({ personalSpaceId: SPACE, projectId: 'ops', leadAgentId: 'lead-ops', terms: ['部署'],
    responsibility: 'Synthetic ops work', source: 'user' });
  await assert.rejects(correct(app, 'preview', 'edit_terms', { addTerms: ['部署'] }),
    { code: 'standing_assignment_term_taken', message: /"部署" already names the standing assignment of project ops/ });
  await assert.rejects(correct(app, 'preview', 'edit_terms', { removeTerms: ['iDev', '工时'] }),
    { code: 'standing_assignment_terms_empty', message: /retire it/ });
  await assert.rejects(correct(app, 'preview', 'edit_terms', { removeTerms: ['报工'] }),
    { code: 'standing_assignment_term_absent' });
  await assert.rejects(correct(app, 'preview', 'edit_terms', { addTerms: ['IDEV'] }),
    { code: 'standing_assignment_unchanged' });

  const preview = await correct(app, 'preview', 'edit_terms', { addTerms: ['报工'], removeTerms: ['idev'] });
  assert.equal(preview.restatement, 'FULI will send later tasks that mention "工时", "报工" to project "Timesheet" '
    + '(lead "lead-timesheet name"), instead of those that mention "iDev", "工时"; nothing is done now.');
  const done = await correct(app, 'confirm', 'edit_terms', { addTerms: ['报工'], removeTerms: ['idev'],
    confirmationDigest: preview.confirmationDigest });
  assert.deepEqual([done.status, done.assignment.terms], ['terms_edited', ['工时', '报工']]);
  assert.deepEqual(app.standingAssignments.match(SPACE, 'fill iDev hours'), []);
  assert.deepEqual(app.standingAssignments.match(SPACE, '今天报工').map(({ matchedTerms }) => matchedTerms), [['报工']]);
  // The removed term is free again; the remaining terms still name this assignment.
  assert.equal(app.standingAssignments.named(SPACE, 'iDev'), null);
  await assert.rejects(correct(app, 'preview', 'edit_terms', { term: '报工', removeTerms: ['工时', '报工'] }),
    { code: 'standing_assignment_terms_empty' });
  assert.deepEqual(changes(app, assignment.assignmentId).at(-1), ['terms_edited', 'user', 'session-synthetic']);
});

test('internal Agent activity cannot correct or end an assignment', async (t) => {
  for (const options of [{ delegated: true },
    { activityOrigin: { version: 1, kind: 'ai_internal', source: 'roundtable_delegation', purpose: 'delegated_work' } }]) {
    const { app, assignment } = application(t, options);
    for (const change of ['retire', 'reassign', 'edit_terms']) {
      await assert.rejects(correct(app, 'preview', change, { addTerms: ['报工'] }),
        { code: 'standing_assignment_internal_activity', status: 403 });
    }
    assert.deepEqual(app.standingAssignments.list(SPACE), [assignment]);
  }
  const { app } = application(t);
  await assert.rejects(correct(app, 'preview', 'rename'), /change must be register, retire, reassign or edit_terms/);
});

function request(method, body, remoteAddress) {
  const stream = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  return Object.assign(stream, { method, headers: { 'content-type': 'application/json' }, socket: { remoteAddress } });
}

async function api(app, method, path, body = null, remoteAddress = '127.0.0.1') {
  const sent = {};
  const response = { setHeader() {}, writeHead(status) { sent.status = status; },
    end(text) { sent.body = text ? JSON.parse(text) : null; } };
  try {
    sent.handled = await handleStandingAssignmentRequest({ request: request(method, body, remoteAddress), response,
      url: new URL(`http://127.0.0.1${path}`), app });
  } catch (error) {
    Object.assign(sent, mapHttpError(error));
  }
  return sent;
}

test('the console lists and changes assignments on this computer only, at the revision it read', async (t) => {
  const { app, assignment } = application(t);
  const base = `/api/standing-assignments/${assignment.assignmentId}`;
  const listed = await api(app, 'GET', '/api/standing-assignments');
  assert.deepEqual([listed.status, listed.body.assignments], [200, [assignment]]);
  for (const [method, path, body] of [['GET', '/api/standing-assignments'], ['POST', `${base}/retire`, { expectedRevision: 1 }],
    ['POST', `${base}/reassign`, { expectedRevision: 1, projectId: 'ops' }],
    ['POST', `${base}/terms`, { expectedRevision: 1, addTerms: ['报工'] }]]) {
    const remote = await api(app, method, path, body, '192.168.1.20');
    assert.deepEqual([remote.status, remote.body.code], [403, 'local_user_only'], path);
  }
  assert.equal(app.standingAssignments.history(assignment.assignmentId).length, 1);

  const stale = await api(app, 'POST', `${base}/retire`, { expectedRevision: 2 });
  assert.deepEqual([stale.status, stale.body.code], [409, 'standing_assignment_changed']);
  const foreign = await api(app, 'POST', `${base}/reassign`, { expectedRevision: 1, projectId: 'ops',
    leadAgentId: 'helper-timesheet' });
  assert.deepEqual([foreign.status, foreign.body.code], [422, 'standing_assignment_lead_not_in_project']);
  assert.equal((await api(app, 'POST', `${base}/terms`, {})).status, 400);

  const moved = await api(app, 'POST', `${base}/reassign`, { expectedRevision: 1, projectId: 'ops' });
  assert.deepEqual([moved.status, moved.body.assignment.leadAgentId], [200, 'lead-ops']);
  assert.equal(await routedProject(app), 'ops');
  const edited = await api(app, 'POST', `${base}/terms`, { expectedRevision: 2, removeTerms: ['iDev'] });
  assert.deepEqual(edited.body.assignment.terms, ['工时']);
  const retired = await api(app, 'POST', `${base}/retire`, { expectedRevision: 3 });
  assert.ok(retired.body.assignment.retiredAt);
  assert.deepEqual(changes(app, assignment.assignmentId), [['registered', 'user', 'session-register'],
    ['reassigned', 'user', null], ['terms_edited', 'user', null], ['retired', 'user', null]]);
  assert.equal(await routedProject(app), 'repo-a');
  assert.equal((await api(app, 'GET', '/api/standing-assignments/other')).handled, false);

  const catalog = new Map(agentInterfaceCatalog().uiMutationParity.map(entry => [entry.route, entry.access]));
  for (const action of ['retire', 'reassign', 'terms']) {
    assert.equal(catalog.get(`POST /api/standing-assignments/:assignmentId/${action}`), 'local_user_only');
  }
});
