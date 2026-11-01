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
  // The Agent each role selection asked for (null: the Provider's own choice).
  const requested = [];
  Object.assign(app.personal, {
    getProjectAgent: record('getProjectAgent', async () => {
      throw Object.assign(new Error('Not found'), { status: 404 });
    }),
    listProjectAgentAssignments: record('listProjectAgentAssignments', async () => []),
    getPersonalProject: record('getPersonalProject', async (_, id) => projects.get(id)),
    // As the Provider: the project's lead stays accountable, and a named
    // Agent other than the lead is the requested member reporting to it.
    resolveProjectAgentContext: record('resolveProjectAgentContext', async input => {
      requested.push(input.agent_id);
      const accountable = lead(input.personal_project_id);
      return { status: 'ready', agent: accountable, ...(input.agent_id && input.agent_id !== accountable.agent_id
        ? { reason: 'project_lead_reporting', requested_agent_id: input.agent_id } : {}) };
    }),
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
  return { app, run, calls, tasks, searches, requested };
}

function lead(project) {
  return { agent_id: `lead-${project}`, personal_space_id: SPACE, personal_project_id: project,
    profile: { name: 'Synthetic lead', display_name: project === 'timesheet' ? 'Timesheet Lead' : null,
      status: 'active', allowed_clients: ['codex'], work_kinds: ['project_context'], capabilities: [] } };
}

test('a term from another repository\'s session scopes this task to the standing project only', async () => {
  const { app, run, tasks, searches } = fixture();
  const entry = await run();
  assert.equal(entry.context.personal_project_id, 'timesheet');
  assert.equal(entry.context.project_resolution.basis, 'standing_assignment');
  assert.equal(entry.project_agent_context.project_agent_id, 'lead-timesheet');
  const [assignment] = app.standingAssignments.list(SPACE);
  assert.deepEqual(entry.standing_owner, { status: 'routed', assignment_id: assignment.assignmentId,
    project_id: 'timesheet', project_name: 'Timesheet',
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
  assert.ok(tasks[0].agentAssignment.match_basis.some(basis => /^standing_assignment:standing-\S+ /.test(basis)
    && basis.endsWith(` ${NOTICE}`)));
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
  assert.doesNotMatch(result.agent_receipt.markdown, /standing_assignment|standing-/);
});

const UNCLAIMED = { status: 'not_provided', basis: null, personalProjectId: null };
const opsTask = { token: 'fuli-task-synthetic-ops', personalProjectId: 'ops', projectAgentId: 'lead-ops',
  projectScope: null, agentAssignment: null };

test('a session owned by another project returns there after one or more routed tasks', async () => {
  for (const routedCount of [1, 2]) {
    const { run, tasks } = fixture({ resolution: UNCLAIMED });
    tasks.push(opsTask);
    for (let index = 0; index < routedCount; index++) {
      const routed = await run({ projectPath: null });
      assert.equal(routed.context.personal_project_id, 'timesheet');
      assert.equal(routed.standing_owner.session_project_id, 'ops');
    }
    const next = await run({ projectPath: null, taskPrompt: '部署脚本再检查一下' });
    assert.equal(next.context.personal_project_id, 'ops', `after ${routedCount} routed task(s)`);
    assert.equal(next.context.project_resolution.basis, 'host_session_context');
  }
});

test('a global Agent session returns to that Agent after a routed task', async () => {
  const { app, run, tasks } = fixture({ resolution: UNCLAIMED });
  app.personal.getProjectAgent = async (_, project, id) => ({ ...lead(null), agent_id: id });
  tasks.push({ token: 'fuli-task-synthetic-global', personalProjectId: null, projectAgentId: 'global-engineer',
    projectScope: null, agentAssignment: null });
  assert.equal((await run({ projectPath: null })).standing_owner.session_agent_id, 'global-engineer');
  const next = await run({ projectPath: null, taskPrompt: '随便问个问题' });
  assert.equal(next.context.personal_project_id, null);
  assert.equal(next.agent_receipt.owner.agent_id, 'global-engineer');
});

test('the route is stored even when no Agent could be selected', async () => {
  const { app, run, tasks } = fixture({ resolution: UNCLAIMED });
  tasks.push(opsTask);
  app.personal.resolveProjectAgentContext = async () => { throw new Error('Synthetic role read failure'); };
  const routed = await run({ projectPath: null });
  assert.equal(routed.context.personal_project_id, 'timesheet');
  assert.equal(routed.project_agent_context.status, 'unavailable');
  assert.equal(routed.standing_owner.lead_name, null);
  assert.match(routed.agent_receipt.markdown, /本次任务按长期职责归入项目 Timesheet（负责人 lead-timesheet）/);
  const stored = tasks.at(-1).agentAssignment;
  assert.equal(stored.selection_reason, null);
  assert.deepEqual(stored.match_basis.map(basis => basis.split(':')[0]),
    ['standing_assignment', 'standing_session_project', 'entry_unassigned']);
  // Its checkpoint receipt gives the entry's reason for having no owner.
  assert.equal(stored.match_basis.at(-1), 'entry_unassigned:unavailable -');
  // The next plain task does not inherit timesheet as an ordinary session project.
  assert.equal((await run({ projectPath: null, taskPrompt: '部署脚本再检查一下' })).context.personal_project_id, 'ops');
});

test('a routed task is recognized by its assignment prefix, never by the notice wording', async () => {
  const { run, tasks } = fixture({ resolution: { status: 'not_provided', basis: null, personalProjectId: null } });
  await run({ projectPath: null });
  const routed = tasks[0].agentAssignment.match_basis.find(basis => basis.startsWith('standing_assignment:'));
  const reworded = routed.replace(NOTICE, 'This task follows your standing assignment to project Timesheet');
  // The same task, its notice reworded or translated: the session still does not inherit it.
  tasks.push({ ...tasks[0], agentAssignment: { ...tasks[0].agentAssignment, match_basis: [reworded] } });
  assert.equal((await run({ projectPath: null, taskPrompt: '随便问个问题' })).context.personal_project_id, null);
  // The human sentence alone, without the prefix, is an ordinary basis: the session continues there.
  tasks.push({ ...tasks[0], agentAssignment: { ...tasks[0].agentAssignment, match_basis: [NOTICE] } });
  assert.equal((await run({ projectPath: null, taskPrompt: '随便问个问题' })).context.personal_project_id, 'timesheet');
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
  app.standingAssignments.correct(assignment.assignmentId, { action: 'retire' },
    { source: 'user', expectedRevision: assignment.revision });
  const entry = await run();
  assert.equal(entry.context.personal_project_id, 'repo-a');
  assert.equal(entry.standing_owner, undefined);
});

// dot P2 on #342: the Agent the assignment names is the Agent the task asks for.

const reassign = (app, leadAgentId, projectId = 'timesheet') => {
  const [assignment] = app.standingAssignments.list(SPACE);
  app.standingAssignments.correct(assignment.assignmentId, { action: 'reassign', projectId, leadAgentId },
    { source: 'user', expectedRevision: assignment.revision });
};

test('a routed task asks for the Agent a correction pointed the assignment at', async () => {
  const { app, run, requested } = fixture();
  reassign(app, 'helper-timesheet');
  const entry = await run();
  assert.equal(entry.context.personal_project_id, 'timesheet');
  assert.deepEqual(requested, [null, 'helper-timesheet']);
  // The Provider keeps the lead accountable; the assignment's Agent is the one the task asks for.
  assert.equal(entry.project_agent_context.project_agent_id, 'lead-timesheet');
  assert.equal(entry.project_agent_context.requested_agent_id, 'helper-timesheet');
  assert.equal(entry.standing_owner.lead_agent_id, 'helper-timesheet');
  const held = '本次任务按长期职责归入项目 Timesheet，由负责人 Timesheet Lead 持有，请求 helper-timesheet 处理';
  assert.equal(entry.standing_owner.notice, held);
  assert.match(entry.agent_receipt.markdown, new RegExp(`· ${held}$`));
  assert.equal(entry.standing_owner.owner_resolved, undefined);
  // An explicit Agent still wins over the assignment.
  const explicit = fixture();
  reassign(explicit.app, 'helper-timesheet');
  await explicit.run({ projectAgentId: 'lead-repo-a' });
  assert.deepEqual(explicit.requested, ['lead-repo-a']);
});

test('an assignment Agent that cannot be reached keeps the first selection and the notice says so', async () => {
  const { app, run, requested } = fixture();
  reassign(app, 'helper-timesheet');
  const resolve = app.personal.resolveProjectAgentContext;
  app.personal.resolveProjectAgentContext = async input => {
    const value = await resolve(input);
    if (input.agent_id) throw new Error('Synthetic Provider timeout');
    return value;
  };
  const entry = await run();
  assert.deepEqual(requested, [null, 'helper-timesheet']);
  assert.equal(entry.project_agent_context.status, 'ready');
  assert.equal(entry.project_agent_context.project_agent_id, 'lead-timesheet');
  assert.equal(entry.project_agent_context.requested_agent_id, undefined);
  const notice = '本次任务按长期职责归入项目 Timesheet，职责 Agent helper-timesheet 暂时联系不上，由 Timesheet Lead 处理';
  assert.deepEqual([entry.standing_owner.notice, entry.standing_owner.owner_resolved], [notice, false]);
  assert.match(entry.agent_receipt.markdown, new RegExp(`· ${notice}$`));
});

test('in its own project an assignment changes the selection only when its Agent is not the one chosen', async () => {
  const inProject = { status: 'matched', basis: 'repository_root', personalProjectId: 'timesheet' };
  const same = fixture({ resolution: inProject });
  const without = fixture({ resolution: inProject, standing: false });
  assert.equal(JSON.stringify(await same.run()), JSON.stringify(await without.run()));
  assert.deepEqual(same.requested, [null]);
  const other = fixture({ resolution: inProject });
  reassign(other.app, 'helper-timesheet');
  const entry = await other.run();
  assert.deepEqual(other.requested, [null, 'helper-timesheet']);
  assert.equal(entry.project_agent_context.requested_agent_id, 'helper-timesheet');
  assert.equal(entry.context.personal_project_id, 'timesheet');
  assert.equal(entry.standing_owner, undefined, 'the task was not moved, so there is no routing notice');
});

test('routing adds no Provider round trip to the entry', async () => {
  const routed = fixture();
  await routed.run();
  const plain = fixture({ standing: false });
  await plain.run();
  assert.deepEqual(routed.calls, plain.calls);
  assert.equal(routed.calls.filter(name => name === 'listPersonalProjects').length, 1);
});
