import assert from 'node:assert/strict';
import test from 'node:test';

import { checkpointTaskKnowledge } from '../src/graphiti/agent-knowledge-workflows.js';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { createStandingAssignments } from '../src/standing-assignments/port.js';

// rec#29 F3 (D-41 D3, option b): a task whose prompt carries a standing
// assignment's term is scoped to that project while its session stays where
// it belongs. Synthetic Provider boundary and an in-memory store only; no real
// data, client or model.

const SPACE = 'synthetic-space';
const REPO = { status: 'matched', basis: 'repository_root', personalProjectId: 'repo-a' };
const NOTICE = '本次任务按长期职责归入项目 Timesheet（负责人 Timesheet Lead）';

function fixture({ resolution = REPO, existing = ['repo-a', 'timesheet', 'ops'], standing = true } = {}) {
  const calls = [];
  const tasks = [];
  const projects = new Map(existing.map(id => [id, { project_id: id, scope_type: 'registered',
    profile: { name: id === 'timesheet' ? 'Timesheet' : id } }]));
  const app = new FederatedGraphApplication({ version: 1, personal: {
    providerUrl: 'http://127.0.0.1:8787', accessToken: 'synthetic-test-token',
    principalId: 'synthetic-user', spaceId: SPACE
  }, workspaces: [] }, { projectPathResolver: () => resolution,
    // The project list goes through the real client, so the entry's one shared read is what is counted.
    fetchImpl: async url => {
      if (!String(url).includes('/v1/personal-projects?')) throw new Error('Unexpected Provider request');
      calls.push('listPersonalProjects');
      return new Response(JSON.stringify([...projects.values()]), { headers: { 'content-type': 'application/json' } });
    } });
  app.taskContextRegistry = { current: async () => tasks.at(-1) ?? null,
    begin: async input => { const task = { ...input, token: `fuli-task-synthetic-${tasks.length}` };
      tasks.push(task); return task; } };
  const record = (name, read) => async (...args) => { calls.push(name); return read(...args); };
  Object.assign(app.personal, {
    getProjectAgent: record('getProjectAgent', async () => {
      throw Object.assign(new Error('Not found'), { status: 404 });
    }),
    listProjectAgentAssignments: record('listProjectAgentAssignments', async () => []),
    getPersonalProject: record('getPersonalProject', async (_, id) => projects.get(id)),
    resolveProjectAgentContext: record('resolveProjectAgentContext', async input => ({ status: 'ready',
      agent: lead(input.personal_project_id) })),
    collaborationPreferences: record('collaborationPreferences', async (space, project, limit, agent) => ({
      personal_space_id: space, personal_project_id: project, project_agent_id: agent,
      effective_preferences: [], global_preferences: [], conflicts: [] })),
    listPreferenceConflicts: async () => [],
    getProjectAgentCoordinationPolicy: async () => ({}),
    listProjectAgents: async () => [],
    listProjectAgentTasks: record('listProjectAgentTasks', async () => [])
  });
  const searches = [];
  app.searchKnowledge = async input => { searches.push(input.personalProjectId); return { facts: [], entities: [] }; };
  if (standing) {
    app.standingAssignments = createStandingAssignments();
    app.standingAssignments.register({ personalSpaceId: SPACE, projectId: 'timesheet', leadAgentId: 'lead-timesheet',
      terms: ['iDev', '工时'], responsibility: 'Fill the synthetic timesheet', source: 'user' });
  }
  const run = extra => app.getCollaborationPreferences({ projectPath: '/synthetic/repo-a',
    sourceApplication: 'codex', sourceSessionId: 'synthetic-host-a', sessionId: 'synthetic-session-a',
    agentInvocation: true, agentToolName: 'get_collaboration_preferences', taskPrompt: '帮我填一下今天的工时', ...extra });
  return { app, run, calls, tasks, searches };
}

function lead(project) {
  return { agent_id: `lead-${project}`, personal_space_id: SPACE, personal_project_id: project,
    profile: { name: 'Synthetic lead', display_name: project === 'timesheet' ? 'Timesheet Lead' : null,
      status: 'active', allowed_clients: ['codex'], work_kinds: ['project_context'], capabilities: [] } };
}

test('a term from another repository\'s session scopes this task to the standing project only', async () => {
  const { run, tasks, searches } = fixture();
  const entry = await run();
  assert.equal(entry.context.personal_project_id, 'timesheet');
  assert.equal(entry.context.project_resolution.basis, 'standing_assignment');
  assert.equal(entry.project_agent_context.project_agent_id, 'lead-timesheet');
  assert.deepEqual(entry.standing_owner, { status: 'routed', project_id: 'timesheet', project_name: 'Timesheet',
    lead_agent_id: 'lead-timesheet', matched_terms: ['工时'], lead_name: 'Timesheet Lead',
    session_project_id: 'repo-a', notice: NOTICE });
  assert.match(entry.agent_receipt.markdown, new RegExp(`· ${NOTICE}$`));
  assert.equal(tasks[0].personalProjectId, 'timesheet');
  assert.ok(searches.length && searches.every(project => project === 'timesheet'), 'knowledge stays in the task scope');
  // The session keeps its repository: a later task without a term stays in repo-a.
  const next = await run({ taskPrompt: '继续看一下构建' });
  assert.equal(next.context.personal_project_id, 'repo-a');
  assert.equal(next.standing_owner, undefined);
});

test('a new session with no project takes the standing project and does not inherit it', async () => {
  const { run, tasks } = fixture({ resolution: { status: 'not_provided', basis: null, personalProjectId: null } });
  const entry = await run({ projectPath: null, taskPrompt: 'iDev 那边的工时帮我补上' });
  assert.equal(entry.context.personal_project_id, 'timesheet');
  assert.equal(entry.standing_owner.session_project_id, null);
  assert.deepEqual(entry.standing_owner.matched_terms, ['iDev', '工时']);
  assert.ok(tasks[0].agentAssignment.match_basis.includes(NOTICE));
  // The routed task is the session's latest, yet the session itself was never moved there.
  const next = await run({ projectPath: null, taskPrompt: '随便问个问题' });
  assert.equal(next.context.personal_project_id, null);
  assert.equal(next.context.project_resolution.basis, 'pending_assignment');
});

test('the checkpoint receipt repeats the routed task\'s sentence', async () => {
  const entry = fixture();
  await entry.run();
  const begun = entry.tasks[0];
  let checkpoint = null;
  const task = () => ({ token: begun.token, sessionId: begun.sessionId, personalProjectId: begun.personalProjectId,
    projectAgentId: begun.projectAgentId, sourceApplication: 'codex', agentAssignment: begun.agentAssignment,
    projectScope: null, workLogRequired: false, checkpoint });
  const app = { config: { personal: { spaceId: SPACE } }, getCapturePolicy: () => ({ enabled: true }),
    taskContextRegistry: { context: async () => task(),
      prepare: async (_token, value) => { checkpoint = { ...value, phase: 'prepare' }; return task(); },
      checkpoint: async (_token, value) => { checkpoint = { ...checkpoint, ...value, phase: 'complete' }; return task(); } },
    personal: { conversation: async () => ({ status: 'saved', conversation_id: 'synthetic-conversation' }),
      getProjectAgent: async () => lead('timesheet') } };
  const result = await checkpointTaskKnowledge(app, { taskContextToken: begun.token, sourceApplication: 'codex',
    disposition: 'retain_nothing', reason: 'Synthetic timesheet filled' });
  assert.match(result.agent_receipt.markdown, new RegExp(`· ${NOTICE}`));
});

test('terms of several assignments ask instead of switching', async () => {
  const { app, run } = fixture();
  app.standingAssignments.register({ personalSpaceId: SPACE, projectId: 'ops', leadAgentId: 'lead-ops',
    terms: ['部署'], responsibility: 'Synthetic deploys', source: 'user' });
  const entry = await run({ taskPrompt: '部署完把工时也填了' });
  assert.equal(entry.context.personal_project_id, 'repo-a');
  assert.equal(entry.standing_owner.status, 'clarification_required');
  assert.deepEqual(entry.standing_owner.candidates.map(item => [item.project_id, item.matched_terms]).sort(),
    [['ops', ['部署']], ['timesheet', ['工时']]]);
  assert.match(entry.standing_owner.guidance, /Ask the user once/);
  assert.doesNotMatch(entry.agent_receipt.markdown, /长期职责/);
});

test('an explicit project, Agent or project named in the prompt outranks the standing assignment', async () => {
  // Inside a repository the named project keeps today's answer; checking the name creates nothing
  // (a create would be an unexpected Provider request).
  const { run } = fixture();
  for (const extra of [{ personalProjectId: 'repo-a', projectPath: null }, { taskPrompt: 'ops: 把工时表也看一下' },
    { taskPrompt: '新项目：Payroll 工时汇总' }]) {
    const entry = await run(extra);
    assert.equal(entry.context.personal_project_id, 'repo-a', JSON.stringify(extra));
    assert.equal(entry.standing_owner, undefined);
  }
  const unclaimed = fixture({ resolution: { status: 'not_provided', basis: null, personalProjectId: null } });
  assert.equal((await unclaimed.run({ projectPath: null, taskPrompt: 'ops 的工时' })).context.personal_project_id, 'ops');
  const named = fixture({ resolution: { status: 'not_provided', basis: null, personalProjectId: null } });
  named.app.personal.getProjectAgent = async () => ({ ...lead(null), agent_id: 'global-engineer' });
  for (const extra of [{ projectAgentId: 'global-engineer' }, { taskPrompt: '@global-engineer 填工时' }]) {
    const entry = await named.run({ projectPath: null, ...extra });
    assert.equal(entry.context.personal_project_id, null);
    assert.equal(entry.standing_owner, undefined);
  }
});

test('without a matching term the entry is byte-identical to one without standing assignments', async () => {
  for (const resolution of [REPO, { status: 'not_provided', basis: null, personalProjectId: null }]) {
    for (const taskPrompt of ['继续看一下构建', 'idevelop 的 my_idev 目录']) {
      const without = await fixture({ resolution, standing: false }).run({ taskPrompt });
      const unmatched = await fixture({ resolution }).run({ taskPrompt });
      assert.equal(JSON.stringify(unmatched), JSON.stringify(without));
    }
  }
});

test('a retired assignment no longer routes', async () => {
  const { app, run } = fixture();
  const [assignment] = app.standingAssignments.list(SPACE);
  app.standingAssignments.retire(assignment.assignmentId, { source: 'user', expectedRevision: assignment.revision });
  const entry = await run();
  assert.equal(entry.context.personal_project_id, 'repo-a');
  assert.equal(entry.standing_owner, undefined);
});

test('routing adds no Provider round trip to the entry', async () => {
  const routed = fixture();
  await routed.run();
  const plain = fixture({ standing: false });
  await plain.run();
  assert.deepEqual(routed.calls, plain.calls);
  assert.equal(routed.calls.filter(name => name === 'listPersonalProjects').length, 1);
});
