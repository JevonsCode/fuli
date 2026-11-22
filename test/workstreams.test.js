import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { mapHttpError } from '../src/http/error-mapping.js';
import { handleStandingAssignmentRequest } from '../src/http/standing-assignment-api-router.js';

import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { createStandingAssignments } from '../src/standing-assignments/port.js';
import { buildProjectTeam } from '../src/graphiti/project-team-view.js';
import { registerStandingAssignment } from '../src/graphiti/standing-assignment-entry.js';
import { loadProjectTeamContext } from '../src/graphiti/project-agent-team-context.js';
import { agentWorkstreamLedger } from '../src/graphiti/agent-workstream-ledger.js';
import { taskWorkstreamId } from '../src/graphiti/task-entry-standing-owner.js';

// docs/workstreams.md: one project carries several unrelated lines of work
// that share its repository and release process. Each belongs to its own FLA,
// so a member's project memory holds one line and not three. Synthetic
// Provider boundary, in-memory store, fictional people only.

const SPACE = 'synthetic-space';
const PROJECT = 'campaigns';
const LEAD = 'lead-campaigns';
const PATH = '/synthetic/campaigns';
const IN_PROJECT = { status: 'matched', basis: 'repository_root', personalProjectId: PROJECT };

const MEMBERS = Object.freeze({
  'fla-ember': 'Ember Vale',
  'fla-orin': 'Orin Pike'
});

function agentRow(agentId, name) {
  return { agent_id: agentId, personal_space_id: SPACE, personal_project_id: PROJECT,
    occupation: { role: agentId === LEAD ? 'lead' : 'engineer' },
    profile: { name, display_name: name, status: 'active', allowed_clients: ['codex'],
      work_kinds: ['project_context'], capabilities: [] },
    assignments: [{ personal_project_id: PROJECT, status: 'active', responsibility: `${name} works here` }] };
}

function fixture({ seed = [] } = {}) {
  const tasks = [];
  const requested = [];
  const projects = new Map([[PROJECT, { project_id: PROJECT, scope_type: 'registered',
    profile: { name: 'Campaigns' } }]]);
  const app = new FederatedGraphApplication({ version: 1, personal: {
    providerUrl: 'http://127.0.0.1:8787', accessToken: 'synthetic-test-token',
    principalId: 'synthetic-user', spaceId: SPACE
  }, workspaces: [] }, { projectPathResolver: () => IN_PROJECT,
    fetchImpl: async url => {
      if (!String(url).includes('/v1/personal-projects?')) throw new Error('Unexpected Provider request');
      return new Response(JSON.stringify([...projects.values()]),
        { headers: { 'content-type': 'application/json' } });
    } });
  app.taskContextRegistry = {
    current: async () => tasks.at(-1) ?? null,
    context: async token => tasks.find(task => task.token === token) ?? null,
    begin: async input => { const task = { ...input, token: `fuli-task-synthetic-${tasks.length}` };
      tasks.push(task); return task; }
  };
  const rows = [agentRow(LEAD, 'Mara Quill'),
    ...Object.entries(MEMBERS).map(([agentId, name]) => agentRow(agentId, name))];
  Object.assign(app.personal, {
    getProjectAgent: async (_space, _project, agentId) => rows.find(row => row.agent_id === agentId)
      ?? (() => { throw Object.assign(new Error('Not found'), { status: 404 }); })(),
    listProjectAgentAssignments: async () => [],
    getPersonalProject: async (_space, id) => projects.get(id),
    resolveProjectAgentContext: async input => {
      requested.push(input.agent_id);
      const accountable = rows[0];
      return { status: 'ready', agent: accountable, ...(input.agent_id && input.agent_id !== LEAD
        ? { reason: 'project_lead_reporting', requested_agent_id: input.agent_id } : {}) };
    },
    collaborationPreferences: async (space, project, _limit, agent) => ({ personal_space_id: space,
      personal_project_id: project, project_agent_id: agent, effective_preferences: [], global_preferences: [],
      conflicts: [] }),
    listPreferenceConflicts: async () => [],
    getProjectAgentCoordinationPolicy: async () => ({ team_lead_agent_id: LEAD,
      team_member_agent_ids: Object.keys(MEMBERS) }),
    listProjectAgents: async () => rows,
    listProjectAgentTasks: async () => []
  });
  app.searchKnowledge = async () => ({ facts: [], entities: [] });
  app.standingAssignments = createStandingAssignments();
  for (const line of seed) {
    app.standingAssignments.register({ personalSpaceId: SPACE, projectId: PROJECT, leadAgentId: line.owner,
      terms: line.terms, responsibility: line.name, source: line.source ?? 'host' });
  }
  const run = extra => app.getCollaborationPreferences({ projectPath: PATH, sourceApplication: 'codex',
    sourceSessionId: 'synthetic-host', sessionId: 'synthetic-session', agentInvocation: true,
    agentToolName: 'get_collaboration_preferences', taskPrompt: '看一下这个页面', ...extra });
  return { app, run, tasks, requested };
}

const SPRING = { name: '春促落地页', terms: ['春促', 'spring-sale'], owner: 'fla-ember' };
const COUPON = { name: '优惠券中心', terms: ['优惠券'], owner: 'fla-orin' };

test('a task whose words name a workstream goes to its FLA, and the entry says which line', async () => {
  const { run, requested } = fixture({ seed: [SPRING, COUPON] });
  const entry = await run({ taskPrompt: '春促 的头图换一下' });
  assert.deepEqual(requested, [null, 'fla-ember']);
  assert.equal(entry.context.personal_project_id, PROJECT, 'a workstream never moves the task out of its project');
  assert.equal(entry.project_agent_context.requested_agent_id, 'fla-ember');
  assert.deepEqual([entry.standing_owner.status, entry.standing_owner.workstream,
    entry.standing_owner.owner_agent_id, entry.standing_owner.matched_on],
  ['workstream', '春促落地页', 'fla-ember', ['words']]);
  assert.match(entry.agent_receipt.markdown, /工作线「春促落地页」/);
});

test('the task keeps which line it was, and its session stays in the project', async () => {
  const { run, tasks } = fixture({ seed: [SPRING] });
  const entry = await run({ taskPrompt: '春促 的头图换一下' });
  const stored = tasks.at(-1).agentAssignment.match_basis;
  assert.deepEqual(stored.filter(item => item.startsWith('workstream:')),
    [`workstream:${entry.standing_owner.assignment_id} ${entry.standing_owner.notice}`]);
  // It moves no session, so it carries none of a routed task's session markers.
  assert.equal(stored.some(item => item.startsWith('standing_assignment:')
    || item.startsWith('standing_session_')), false);
  assert.equal(taskWorkstreamId(tasks.at(-1)), entry.standing_owner.assignment_id);
  // The next task of the same session is an ordinary one of the same project.
  const next = await run({ taskPrompt: '发布流程确认一下' });
  assert.equal(next.context.personal_project_id, PROJECT);
  assert.equal(taskWorkstreamId(tasks.at(-1)), null);
});

test('a task run in the workstream\'s own folder reaches it without being told', async () => {
  const { run, requested } = fixture({ seed: [SPRING, COUPON] });
  const entry = await run({ projectPath: `${PATH}/apps/spring-sale`, taskPrompt: '把构建跑一下' });
  assert.deepEqual(requested, [null, 'fla-ember']);
  assert.deepEqual(entry.standing_owner.matched_on, ['folder']);
  assert.deepEqual(entry.standing_owner.matched_terms, ['spring-sale']);
  // A folder that only contains the term is not that folder.
  const near = fixture({ seed: [SPRING] });
  const other = await near.run({ projectPath: `${PATH}/apps/spring-sale-archive`, taskPrompt: '把构建跑一下' });
  assert.deepEqual(near.requested, [null]);
  assert.equal(other.standing_owner, undefined);
});

test('two workstreams matching one task leave it with the lead and ask once', async () => {
  const { run, requested } = fixture({ seed: [SPRING, COUPON] });
  const entry = await run({ taskPrompt: '春促 的 优惠券 文案' });
  assert.deepEqual(requested, [null], 'no member is chosen while it is unclear');
  assert.equal(entry.project_agent_context.project_agent_id, LEAD);
  assert.equal(entry.standing_owner.status, 'clarification_required');
  assert.deepEqual(entry.standing_owner.candidates.map(item => item.workstream).sort(), ['优惠券中心', '春促落地页']);
});

test('a task that names no workstream stays with the lead and adds no line about one', async () => {
  const { run, requested } = fixture({ seed: [SPRING, COUPON] });
  const entry = await run({ taskPrompt: '发布流程确认一下' });
  assert.deepEqual(requested, [null]);
  assert.equal(entry.project_agent_context.project_agent_id, LEAD);
  assert.equal(entry.standing_owner, undefined);
});

test('the lead sees the ledger as facts, and a project without lines carries nothing extra', async () => {
  const divided = fixture({ seed: [SPRING, COUPON] });
  const lines = (await loadProjectTeamContext(divided.app, SPACE, PROJECT)).workstreams;
  assert.deepEqual([...lines].sort((left, right) => left.workstream.localeCompare(right.workstream)),
    [{ workstream: '优惠券中心', owner_agent_id: 'fla-orin', terms: ['优惠券'] },
      { workstream: '春促落地页', owner_agent_id: 'fla-ember', terms: ['春促', 'spring-sale'] }]);
  assert.equal((await loadProjectTeamContext(fixture().app, SPACE, PROJECT)).workstreams, undefined);
});

test('the ledger names each line, its owner, who decided it and when it started', () => {
  const port = createStandingAssignments({ now: () => new Date('2026-11-23T01:00:00.000Z') });
  port.register({ personalSpaceId: SPACE, projectId: PROJECT, leadAgentId: 'fla-ember', terms: ['春促'],
    responsibility: '春促落地页', source: 'host' });
  // An assignment pointing at the project's own lead routes work into the
  // project; it is not one of its lines.
  port.register({ personalSpaceId: SPACE, projectId: PROJECT, leadAgentId: LEAD, terms: ['活动承接'],
    responsibility: 'Campaign intake', source: 'user' });
  const team = buildProjectTeam({ policy: { team_lead_agent_id: LEAD, team_member_agent_ids: Object.keys(MEMBERS) },
    agents: [agentRow(LEAD, 'Mara Quill'), ...Object.entries(MEMBERS).map(([id, name]) => agentRow(id, name))],
    projectId: PROJECT, standingAssignments: port.list(SPACE) });
  assert.deepEqual(team.workstreams.map(({ name, ownerAgentId, ownerName, decidedBy, startedAt, ownerOnProject }) =>
    ({ name, ownerAgentId, ownerName, decidedBy, startedAt, ownerOnProject })),
  [{ name: '春促落地页', ownerAgentId: 'fla-ember', ownerName: 'Ember Vale', decidedBy: 'host',
    startedAt: '2026-11-23T01:00:00.000Z', ownerOnProject: true }]);
  port.close();
});

test('an explicit read of the team says how far each line got; task entry asks for no such read', async () => {
  const { app } = fixture({ seed: [SPRING, COUPON] });
  const reads = [];
  app.personal.listProjectAgentTasks = async input => {
    reads.push(input.agentId);
    return input.agentId === 'fla-ember'
      ? [{ task_id: 'task-1', title: '改头图', status: 'running', updated_at: '2026-11-23T02:00:00.000Z' }] : [];
  };
  const team = await app.getProjectTeam({ personalSpaceId: SPACE, personalProjectId: PROJECT });
  assert.deepEqual(reads.sort(), ['fla-ember', 'fla-orin']);
  // A roster read that shows no progress pays for none of it.
  reads.length = 0;
  const roster = await app.getProjectTeam({ personalSpaceId: SPACE, personalProjectId: PROJECT,
    withProgress: false });
  assert.deepEqual(reads, []);
  assert.deepEqual(roster.workstreams.map(item => item.latestTask), [undefined, undefined]);
  assert.deepEqual(team.workstreams.map(line => [line.name, line.ownerName, line.latestTask?.title ?? null]).sort(),
    [['优惠券中心', 'Orin Pike', null], ['春促落地页', 'Ember Vale', '改头图']]);
  // The entry restores the roster without any of those reads.
  reads.length = 0;
  await loadProjectTeamContext(app, SPACE, PROJECT);
  assert.deepEqual(reads, []);
});

test('a failed progress read leaves that line without a claim instead of failing the ledger', async () => {
  const { app } = fixture({ seed: [SPRING] });
  app.personal.listProjectAgentTasks = async () => { throw new Error('Synthetic Provider timeout'); };
  const team = await app.getProjectTeam({ personalSpaceId: SPACE, personalProjectId: PROJECT });
  assert.deepEqual(team.workstreams.map(line => [line.name, line.latestTask]), [['春促落地页', null]]);
});

test('one FLA\'s ledger covers the projects it leads and the lines it owns', async () => {
  const { app } = fixture({ seed: [SPRING, COUPON] });
  app.personal.listProjectAgentTasks = async input => (input.agentId === 'fla-orin'
    ? [{ task_id: 'task-2', title: '接券接口', status: 'completed', updated_at: '2026-11-21T00:00:00.000Z' }] : []);
  const lead = await agentWorkstreamLedger(app, SPACE, LEAD);
  assert.deepEqual(lead.projects.map(project => [project.projectName, project.leads, project.workstreams.length]),
    [['Campaigns', true, 2]]);
  // A member sees only its own line, with the same four facts.
  const member = await agentWorkstreamLedger(app, SPACE, 'fla-orin');
  assert.deepEqual(member.projects.map(project => project.workstreams.map(line =>
    [project.projectName, line.name, line.ownerName, line.latestTask?.status])),
  [[['Campaigns', '优惠券中心', 'Orin Pike', 'completed']]]);
  assert.equal(member.projects[0].leads, false);
  // An FLA with no line of its own gets an empty ledger, not someone else's.
  assert.deepEqual((await agentWorkstreamLedger(app, SPACE, 'fla-stranger')).projects, []);
});

// The lead's own division of its project's work (change delegate).

function delegating(app, tasks, { projectAgentId = LEAD, personalProjectId = PROJECT } = {}) {
  const task = { token: 'fuli-task-synthetic-delegate', sessionId: 'synthetic-session',
    personalProjectId, projectAgentId, sourceApplication: 'codex' };
  tasks.push(task);
  return input => registerStandingAssignment(app, { action: 'confirm', change: 'delegate',
    taskContextToken: task.token, sourceApplication: 'codex', ...input });
}

test('the lead gives a line of work to a member in one call, recorded as the host\'s', async () => {
  const { app, run, tasks } = fixture();
  const delegate = delegating(app, tasks);
  const result = await delegate({ terms: ['春促', 'spring-sale'], responsibility: '春促落地页',
    leadAgentId: 'fla-ember' });
  assert.equal(result.status, 'created');
  assert.equal(result.executed, false);
  assert.deepEqual([result.workstream.workstream, result.workstream.owner_name], ['春促落地页', 'Ember Vale']);
  const [stored] = app.standingAssignments.list(SPACE);
  assert.deepEqual([stored.projectId, stored.leadAgentId, stored.source], [PROJECT, 'fla-ember', 'host']);
  // It routes from the next task on.
  assert.equal((await run({ taskPrompt: '春促 的头图' })).standing_owner.owner_agent_id, 'fla-ember');
});

test('a delegation refuses the lead itself, a stranger, a project-less task and another Agent asking', async () => {
  const { app, tasks } = fixture();
  const delegate = delegating(app, tasks);
  const line = { terms: ['春促'], responsibility: '春促落地页' };
  await assert.rejects(delegate({ ...line, leadAgentId: LEAD }), { code: 'workstream_owner_is_lead' });
  await assert.rejects(delegate({ ...line, leadAgentId: 'fla-unknown' }), { code: 'workstream_owner_not_in_project' });
  assert.deepEqual(app.standingAssignments.list(SPACE), []);
  const member = fixture();
  await assert.rejects(delegating(member.app, member.tasks, { projectAgentId: 'fla-ember' })(
    { ...line, leadAgentId: 'fla-orin' }), { code: 'workstream_lead_only' });
  const loose = fixture();
  await assert.rejects(delegating(loose.app, loose.tasks, { personalProjectId: null })(
    { ...line, leadAgentId: 'fla-ember' }), { code: 'workstream_project_required' });
});

test('a lead cannot take over a line the person confirmed, and the person can hand it to anyone', async () => {
  const { app, run, tasks } = fixture({ seed: [{ ...SPRING, source: 'user' }] });
  const delegate = delegating(app, tasks);
  // The person's terms name their assignment; no lead may move them elsewhere.
  await assert.rejects(delegate({ terms: ['春促'], responsibility: '春促落地页', leadAgentId: 'fla-orin' }),
    { code: 'standing_assignment_term_taken' });
  // Nor extend what they confirmed.
  await assert.rejects(delegate({ terms: ['春促', '首页'], responsibility: '春促落地页', leadAgentId: 'fla-ember' }),
    { code: 'standing_assignment_user_confirmed' });
  // 「这个还是让 Orin 做」: the person's correction moves the owner and is remembered.
  const [stored] = app.standingAssignments.list(SPACE);
  app.standingAssignments.correct(stored.assignmentId,
    { action: 'reassign', projectId: PROJECT, leadAgentId: 'fla-orin' },
    { source: 'user', expectedRevision: stored.revision });
  const entry = await run({ taskPrompt: '春促 的头图' });
  assert.equal(entry.standing_owner.owner_agent_id, 'fla-orin');
  assert.equal(app.standingAssignments.list(SPACE)[0].revision, 2);
});

// The project page (local console only).

async function api(app, method, path, body = null, remoteAddress = '127.0.0.1') {
  const stream = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  const request = Object.assign(stream, { method, headers: { 'content-type': 'application/json' },
    socket: { remoteAddress } });
  const sent = {};
  const response = { setHeader() {}, writeHead(status) { sent.status = status; },
    end(text) { sent.body = text ? JSON.parse(text) : null; } };
  try {
    sent.handled = await handleStandingAssignmentRequest({ request, response,
      url: new URL(`http://127.0.0.1${path}`), app });
  } catch (error) {
    Object.assign(sent, mapHttpError(error));
  }
  return sent;
}

test('the person opens a workstream on the project page, on this computer only', async () => {
  const { app, run } = fixture();
  const line = { personalProjectId: PROJECT, leadAgentId: 'fla-ember', terms: ['春促'], responsibility: '春促落地页' };
  const remote = await api(app, 'POST', '/api/standing-assignments', line, '192.0.2.20');
  assert.deepEqual([remote.status, remote.body.code], [403, 'local_user_only']);
  assert.deepEqual(app.standingAssignments.list(SPACE), []);
  const opened = await api(app, 'POST', '/api/standing-assignments', line);
  assert.deepEqual([opened.status, opened.body.status, opened.body.workstream.owner_name],
    [200, 'created', 'Ember Vale']);
  // The person opened it, so a lead cannot change it afterwards.
  assert.equal(app.standingAssignments.list(SPACE)[0].source, 'user');
  assert.equal((await run({ taskPrompt: '春促 的头图' })).standing_owner.owner_agent_id, 'fla-ember');
  const toLead = await api(app, 'POST', '/api/standing-assignments', { ...line, leadAgentId: LEAD });
  assert.deepEqual([toLead.status, toLead.body.code], [422, 'workstream_owner_is_lead']);
});

test('a retired line stops routing and keeps every revision', async () => {
  const { app, run } = fixture({ seed: [SPRING] });
  const [stored] = app.standingAssignments.list(SPACE);
  app.standingAssignments.correct(stored.assignmentId, { action: 'retire' },
    { source: 'user', expectedRevision: stored.revision });
  assert.equal((await run({ taskPrompt: '春促 的头图' })).standing_owner, undefined);
  assert.deepEqual(app.standingAssignments.history(stored.assignmentId).map(item => item.change),
    ['registered', 'retired']);
  assert.deepEqual(buildProjectTeam({ policy: { team_lead_agent_id: LEAD }, agents: [], projectId: PROJECT,
    standingAssignments: app.standingAssignments.list(SPACE) }).workstreams, []);
});
