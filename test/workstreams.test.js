import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { buildProjectTeam } from '../src/graphiti/project-team-view.js';
import { registerStandingAssignment } from '../src/graphiti/standing-assignment-entry.js';
import { loadProjectTeamContext } from '../src/graphiti/project-agent-team-context.js';
import { agentWorkstreamLedger, projectWorkstreamLedger } from '../src/graphiti/agent-workstream-ledger.js';
import { mapHttpError } from '../src/http/error-mapping.js';
import { handleStandingAssignmentRequest } from '../src/http/standing-assignment-api-router.js';
import { createStandingAssignments } from '../src/standing-assignments/port.js';

// docs/workstreams.md: one project carries several unrelated lines of work
// that share its repository and release process. When a task belongs to a
// line, the line's owner works it as itself, with its own memory and records.
// Synthetic Provider boundary, a real local store, temporary Git folders and
// fictional people only.

const SPACE = 'synthetic-space';
const PROJECT = 'campaigns';
const OTHER = 'billing';
const LEAD = 'lead-campaigns';
const MEMBERS = Object.freeze({ 'fla-ember': 'Ember Vale', 'fla-orin': 'Orin Pike' });

// A repository on disk: <root>/campaigns with .git and an apps/spring-sale folder.
function repository(t, branch = 'feature/spring-sale') {
  const base = mkdtempSync(join(tmpdir(), 'fuli-workstreams-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'jordan-home', 'campaigns');
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, 'apps', 'spring-sale'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
  return root;
}

function agentRow(agentId, name, projectId = PROJECT) {
  return { agent_id: agentId, personal_space_id: SPACE, personal_project_id: projectId, memory_scope: 'reviewed_agent',
    occupation: { role: agentId === LEAD ? 'lead' : 'engineer' },
    profile: { name, display_name: name, status: 'active', allowed_clients: ['codex'],
      work_kinds: ['project_context'], capabilities: [] },
    assignments: [{ personal_project_id: projectId, status: 'active', responsibility: `${name} works here` }] };
}

function fixture({ seed = [], members = MEMBERS, path = '/synthetic/campaigns', projectOf = () => PROJECT,
  workLog = {} } = {}) {
  const tasks = [];
  const requested = [];
  const memoryReads = [];
  const projects = new Map([[PROJECT, 'Campaigns'], [OTHER, 'Billing']].map(([id, name]) => [id,
    { project_id: id, scope_type: 'registered', profile: { name } }]));
  const app = new FederatedGraphApplication({ version: 1, personal: {
    providerUrl: 'http://127.0.0.1:8787', accessToken: 'synthetic-test-token',
    principalId: 'synthetic-user', spaceId: SPACE
  }, workspaces: [] }, { projectPathResolver: folder => ({ status: 'matched', basis: 'repository_root',
    personalProjectId: projectOf(folder) }),
  fetchImpl: async url => {
    if (!String(url).includes('/v1/personal-projects?')) throw new Error('Unexpected Provider request');
    return new Response(JSON.stringify([...projects.values()]), { headers: { 'content-type': 'application/json' } });
  } });
  app.taskContextRegistry = {
    current: async () => tasks.at(-1) ?? null,
    context: async token => tasks.find(task => task.token === token) ?? null,
    begin: async input => { const task = { ...input, token: `fuli-task-synthetic-${tasks.length}` };
      tasks.push(task); return task; }
  };
  const rows = [agentRow(LEAD, 'Mara Quill'), ...Object.entries(members).map(([id, name]) => agentRow(id, name))];
  const roster = () => rows;
  Object.assign(app.personal, {
    getProjectAgent: async (_space, _project, agentId) => {
      const row = rows.find(item => item.agent_id === agentId)
        ?? (agentId === 'fla-former' ? agentRow('fla-former', 'Fern Holt') : null);
      if (!row) throw Object.assign(new Error('Not found'), { status: 404 });
      return row;
    },
    listProjectAgentAssignments: async () => [],
    getPersonalProject: async (_space, id) => projects.get(id),
    // As the Provider: the lead owns the conversation; a named member is only
    // requested, except a workstream's owner, which runs the turn as itself.
    resolveProjectAgentContext: async input => {
      requested.push(input.workstream_owner ? `owner:${input.agent_id}` : input.agent_id);
      if (input.workstream_owner) {
        const member = rows.find(row => row.agent_id === input.agent_id && row.agent_id !== LEAD);
        return member ? { status: 'ready', reason: 'workstream_owner', agent: member }
          : { status: 'agent_unavailable', reason: 'workstream_owner_not_on_project', agent: null };
      }
      const lead = rows[0];
      return { status: 'ready', reason: 'project_team_lead', agent: lead,
        ...(input.agent_id && input.agent_id !== LEAD ? { reason: 'project_lead_reporting',
          requested_agent_id: input.agent_id } : {}) };
    },
    getProjectAgentMemory: async input => {
      memoryReads.push(`${input.personalProjectId}:${input.agentId}`);
      if (workLog[input.agentId] instanceof Error) throw workLog[input.agentId];
      return { personal_space_id: SPACE, personal_project_id: input.personalProjectId, agent_id: input.agentId,
        scope: input.personalProjectId ? 'project' : 'global', revision: 0, current: null, history: [],
        work_log: workLog[input.agentId] ?? [] };
    },
    collaborationPreferences: async (space, project, _limit, agent) => ({ personal_space_id: space,
      personal_project_id: project, project_agent_id: agent, effective_preferences: [], global_preferences: [],
      conflicts: [] }),
    listPreferenceConflicts: async () => [],
    getProjectAgentCoordinationPolicy: async () => ({ team_lead_agent_id: LEAD,
      team_member_agent_ids: Object.keys(members) }),
    listProjectAgents: async () => roster(),
    listProjectAgentTasks: async () => []
  });
  app.searchKnowledge = async () => ({ facts: [], entities: [] });
  app.standingAssignments = createStandingAssignments();
  for (const line of seed) {
    app.standingAssignments.register({ personalSpaceId: SPACE, projectId: line.projectId ?? PROJECT,
      leadAgentId: line.owner, terms: line.terms, responsibility: line.name, source: line.source ?? 'host' });
  }
  const run = extra => app.getCollaborationPreferences({ projectPath: path, sourceApplication: 'codex',
    sourceSessionId: 'synthetic-host', sessionId: 'synthetic-session', agentInvocation: true,
    agentToolName: 'get_collaboration_preferences', taskPrompt: '看一下这个页面', ...extra });
  return { app, run, tasks, requested, memoryReads };
}

const SPRING = { name: '春促落地页', terms: ['春促', 'spring-sale'], owner: 'fla-ember' };
const COUPON = { name: '优惠券中心', terms: ['优惠券'], owner: 'fla-orin' };
const lineId = app => name => app.standingAssignments.list(SPACE).find(line => line.responsibility === name).assignmentId;

test('a matched line\'s owner is this turn\'s FLA: its own memory, task and receipt', async () => {
  const { run, tasks, requested, memoryReads } = fixture({ seed: [SPRING, COUPON] });
  const entry = await run({ taskPrompt: '春促 的头图换一下' });
  assert.deepEqual(requested, [null, 'owner:fla-ember']);
  assert.equal(entry.project_agent_context.project_agent_id, 'fla-ember');
  assert.equal(entry.project_agent_context.selection_reason, 'workstream_owner');
  // Not held by the lead: no requested member, no lead-only guidance.
  assert.equal(entry.project_agent_context.requested_agent_id, undefined);
  // Its own project memory is what the entry restored, never the lead's.
  assert.ok(memoryReads.includes(`${PROJECT}:fla-ember`));
  assert.ok(!memoryReads.includes(`${PROJECT}:${LEAD}`));
  // The task, so its work log and checkpoint, is the member's.
  assert.equal(tasks.at(-1).projectAgentId, 'fla-ember');
  assert.equal(entry.standing_owner.notice, '工作线「春促落地页」由 Ember Vale 接着做');
  assert.match(entry.agent_receipt.markdown, /Ember Vale/);
  assert.match(entry.agent_receipt.markdown, /工作线「春促落地页」由 Ember Vale 接着做/);
  // The task keeps which line it was, without moving its session.
  const basis = tasks.at(-1).agentAssignment.match_basis;
  assert.ok(basis.some(item => item.startsWith('workstream:')));
  assert.ok(!basis.some(item => item.startsWith('standing_assignment:') || item.startsWith('standing_session_')));
});

test('later turns of the session stay with the line until another line or the person decides', async () => {
  const { run, tasks } = fixture({ seed: [SPRING, COUPON] });
  await run({ taskPrompt: '春促 的头图换一下' });
  const next = await run({ taskPrompt: '再把按钮颜色调深一点' });
  assert.equal(next.project_agent_context.project_agent_id, 'fla-ember');
  assert.deepEqual(next.standing_owner?.matched_on, ['session']);
  assert.equal(tasks.at(-1).projectAgentId, 'fla-ember');
  // Another line's words move the session to that line.
  const coupon = await run({ taskPrompt: '优惠券 列表空了' });
  assert.equal(coupon.project_agent_context.project_agent_id, 'fla-orin');
  // An explicit #FLA ends it: the person named who.
  const lead = await run({ taskPrompt: '#FLA Mara Quill 看下发布流程' });
  assert.equal(lead.project_agent_context.project_agent_id, LEAD);
  assert.equal(lead.standing_owner, undefined);
});

test('a request that names the project keeps its lines', async () => {
  const { run } = fixture({ seed: [SPRING] });
  const entry = await run({ taskPrompt: 'Campaigns 的 春促 页面改下文案' });
  assert.equal(entry.project_agent_context.project_agent_id, 'fla-ember');
});

test('naming a line\'s owner hands the turn to it in one call, as the lead does', async () => {
  const { run, requested } = fixture({ seed: [SPRING] });
  const entry = await run({ taskPrompt: '#FLA Ember Vale 改一下头图' });
  assert.equal(entry.project_agent_context.project_agent_id, 'fla-ember');
  assert.equal(entry.project_agent_context.selection_reason, 'workstream_owner');
  assert.ok(requested.includes('owner:fla-ember'));
  // A member without a line is still held by the lead, as before.
  const plain = fixture({ seed: [SPRING] });
  const orin = await plain.run({ taskPrompt: '#FLA Orin Pike 看看' });
  assert.equal(orin.project_agent_context.project_agent_id, LEAD);
  assert.equal(orin.project_agent_context.requested_agent_id, 'fla-orin');
});

test('two lines matching leave the task with the lead and ask once; none leaves it with the lead quietly', async () => {
  const both = fixture({ seed: [SPRING, COUPON] });
  const asked = await both.run({ taskPrompt: '春促 的 优惠券 文案' });
  assert.deepEqual(both.requested, [null]);
  assert.equal(asked.project_agent_context.project_agent_id, LEAD);
  assert.equal(asked.standing_owner.status, 'clarification_required');
  assert.deepEqual(asked.standing_owner.candidates.map(item => item.workstream).sort(), ['优惠券中心', '春促落地页']);
  const none = fixture({ seed: [SPRING, COUPON] });
  const plain = await none.run({ taskPrompt: '发布流程确认一下' });
  assert.deepEqual(none.requested, [null]);
  assert.equal(plain.standing_owner, undefined);
});

test('a folder below the repository root names its line; folders above it never do', async t => {
  const root = repository(t, 'main');
  const below = fixture({ seed: [SPRING], path: join(root, 'apps', 'spring-sale') });
  const entry = await below.run({ taskPrompt: '把构建跑一下' });
  assert.equal(entry.project_agent_context.project_agent_id, 'fla-ember');
  assert.deepEqual(entry.standing_owner.matched_on, ['folder']);
  // The user's home folder and the repository's own name are above the root.
  const above = fixture({ seed: [{ name: '后台', terms: ['jordan-home', 'campaigns'], owner: 'fla-orin' }], path: root });
  assert.equal((await above.run({ taskPrompt: '把构建跑一下' })).standing_owner, undefined);
  assert.deepEqual(above.requested, [null]);
  // A folder that only contains the term is not that folder.
  const near = fixture({ seed: [SPRING], path: join(root, 'apps') });
  assert.equal((await near.run({ taskPrompt: '把构建跑一下' })).standing_owner, undefined);
});

test('a Windows path from another system matches no folder term', async () => {
  const windows = fixture({ seed: [{ name: '后台', terms: ['admin-console'], owner: 'fla-orin' }],
    path: 'C:\\Users\\admin-console\\code\\other' });
  assert.equal((await windows.run({ taskPrompt: '把构建跑一下' }).catch(() => ({}))).standing_owner, undefined);
});

test('a branch term names its line; a shared branch never does', async t => {
  const onBranch = fixture({ seed: [{ ...SPRING, terms: ['春促', 'branch:feature/spring-sale'] }],
    path: repository(t) });
  const entry = await onBranch.run({ taskPrompt: '把构建跑一下' });
  assert.equal(entry.project_agent_context.project_agent_id, 'fla-ember');
  assert.deepEqual(entry.standing_owner.matched_on, ['branch']);
  const prefix = fixture({ seed: [{ ...SPRING, terms: ['春促', 'branch:feature/'] }], path: repository(t) });
  assert.deepEqual((await prefix.run({ taskPrompt: '把构建跑一下' })).standing_owner.matched_on, ['branch']);
  assert.throws(() => createStandingAssignments().register({ personalSpaceId: SPACE, projectId: PROJECT,
    leadAgentId: 'fla-ember', terms: ['branch:main'], responsibility: 'x', source: 'host' }),
  { code: 'standing_assignment_term_too_broad' });
  assert.throws(() => createStandingAssignments().register({ personalSpaceId: SPACE, projectId: PROJECT,
    leadAgentId: 'fla-ember', terms: ['branch:release/1.2'], responsibility: 'x', source: 'host' }),
  { code: 'standing_assignment_term_too_broad' });
});

test('a line never pulls another project\'s task into its project', async t => {
  const root = repository(t, 'feature/spring-sale');
  const seed = [{ name: '春促落地页', terms: ['春促页', 'spring-sale', 'branch:feature/spring-sale'], owner: 'fla-ember',
    projectId: OTHER }];
  // A task of Campaigns whose words, folder and branch all name a Billing line stays in Campaigns.
  const { run, requested } = fixture({ seed, path: join(root, 'apps', 'spring-sale') });
  const entry = await run({ taskPrompt: '改 春促页 的按钮' });
  assert.equal(entry.context.personal_project_id, PROJECT);
  assert.equal(entry.standing_owner, undefined);
  assert.deepEqual(requested, [null]);
});

test('the owner of a line who left the project is named, not replaced', async () => {
  const { run } = fixture({ seed: [{ ...SPRING, owner: 'fla-former' }] });
  const entry = await run({ taskPrompt: '春促 的头图换一下' });
  assert.equal(entry.project_agent_context.project_agent_id, LEAD);
  assert.equal(entry.standing_owner.owner_resolved, false);
  assert.equal(entry.standing_owner.reason, 'workstream_owner_not_on_project');
  assert.equal(entry.standing_owner.notice,
    '工作线「春促落地页」的负责人 Fern Holt 已不在本项目，这次由 Mara Quill 处理；可在项目页把这条线交给别人');
});

test('the lead sees the lines as facts and the rule by reference; a project without lines carries neither', async () => {
  const divided = fixture({ seed: [SPRING, COUPON] });
  const team = await loadProjectTeamContext(divided.app, SPACE, PROJECT);
  assert.deepEqual(team.workstreams.map(line => [line.workstream, line.owner_name]).sort(),
    [['优惠券中心', 'Orin Pike'], ['春促落地页', 'Ember Vale']]);
  assert.match(team.workstream_guidance, /begin_task_context with taskPrompt "#FLA <owner name>/);
  const undivided = await loadProjectTeamContext(fixture().app, SPACE, PROJECT);
  assert.equal(undivided.workstreams, undefined);
  assert.equal(undivided.workstream_guidance, undefined);
});

test('how far a line got is its own latest task, not the owner\'s older or other work', async () => {
  const before = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const { app } = fixture({ seed: [SPRING, COUPON], workLog: { 'fla-orin': new Error('Synthetic Provider timeout') } });
  // After the lines opened, whatever the clock's resolution.
  const now = new Date(Date.now() + 60_000).toISOString();
  const id = lineId(app);
  app.personal.getProjectAgentMemory = (read => async input => {
    const value = await read(input);
    if (input.agentId === 'fla-ember') {
      value.work_log = [{ created_at: now, status: 'running', summary: '改头图', workstream_id: id('春促落地页') },
        { created_at: before, status: 'completed', summary: '三个月前的事', workstream_id: id('春促落地页') },
        { created_at: now, status: 'completed', summary: '别的事', workstream_id: null }];
    }
    return value;
  })(app.personal.getProjectAgentMemory);
  const { workstreams } = await projectWorkstreamLedger(app, SPACE, PROJECT);
  const byName = Object.fromEntries(workstreams.map(line => [line.name, line]));
  assert.deepEqual(byName['春促落地页'].latestTask, { status: 'running', summary: '改头图', at: now });
  // A log that could not be read says so; it is never "no task".
  assert.equal(byName['优惠券中心'].latestTask, null);
  assert.equal(byName['优惠券中心'].progressUnreadable, true);
});

test('a line with no task since it opened says so, ignoring work from before it', async () => {
  const before = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const { app } = fixture({ seed: [SPRING] });
  const id = lineId(app)('春促落地页');
  app.personal.getProjectAgentMemory = async input => ({ work_log: [
    { created_at: before, status: 'completed', summary: 'old', workstream_id: id }] , agent_id: input.agentId });
  const { workstreams: [line] } = await projectWorkstreamLedger(app, SPACE, PROJECT);
  assert.equal(line.latestTask, null);
  assert.equal(line.progressUnreadable, undefined);
});

test('one FLA\'s ledger: every line of a project it leads, its own line elsewhere, owners who left marked', async () => {
  const { app } = fixture({ seed: [SPRING, { ...COUPON, owner: 'fla-former' }] });
  const lead = await agentWorkstreamLedger(app, SPACE, LEAD);
  assert.deepEqual(lead.projects.map(project => [project.projectName, project.leads,
    project.workstreams.map(line => [line.name, line.ownerOnProject]).sort()]),
  [['Campaigns', true, [['优惠券中心', false], ['春促落地页', true]]]]);
  const former = await agentWorkstreamLedger(app, SPACE, 'fla-former');
  assert.deepEqual(former.projects.map(project => project.workstreams.map(line => line.name)), [['优惠券中心']]);
  assert.deepEqual((await agentWorkstreamLedger(app, SPACE, 'fla-stranger')).projects, []);
});

// The lead's own division of its project's work.

function asLead(app, tasks, { projectAgentId = LEAD, personalProjectId = PROJECT, basis = [] } = {}) {
  const task = { token: `fuli-task-synthetic-lead-${tasks.length}`, sessionId: 'synthetic-session',
    personalProjectId, projectAgentId, sourceApplication: 'codex', agentAssignment: { match_basis: basis } };
  tasks.push(task);
  return input => registerStandingAssignment(app, { action: 'confirm', taskContextToken: task.token,
    sourceApplication: 'codex', ...input });
}

test('the lead opens a line in one call, recorded as the lead\'s, with the session\'s branch', async () => {
  const { app, tasks } = fixture();
  const lead = asLead(app, tasks, { basis: ['working_branch:feature/spring-sale'] });
  const result = await lead({ change: 'delegate', terms: ['春促', 'spring-sale'], responsibility: '春促落地页',
    leadAgentId: 'fla-ember' });
  assert.equal(result.status, 'created');
  assert.deepEqual(result.workstream.terms, ['春促', 'spring-sale', 'branch:feature/spring-sale']);
  const [stored] = app.standingAssignments.list(SPACE);
  assert.deepEqual([stored.projectId, stored.leadAgentId, stored.source], [PROJECT, 'fla-ember', 'host']);
});

test('opening a line is refused for the lead, a stranger, another Agent, no project and a too-broad word', async () => {
  const { app, tasks } = fixture();
  const lead = asLead(app, tasks);
  const line = { change: 'delegate', terms: ['春促'], responsibility: '春促落地页' };
  await assert.rejects(lead({ ...line, leadAgentId: LEAD }), { code: 'workstream_owner_is_lead' });
  await assert.rejects(lead({ ...line, leadAgentId: 'fla-unknown' }), { code: 'workstream_owner_not_in_project' });
  for (const term of ['页面', '春', 'ab', 'admin']) {
    await assert.rejects(lead({ ...line, terms: [term], leadAgentId: 'fla-ember' }),
      { code: 'standing_assignment_term_too_broad' }, term);
  }
  await assert.rejects(asLead(app, tasks, { projectAgentId: 'fla-ember' })({ ...line, leadAgentId: 'fla-orin' }),
    { code: 'workstream_lead_only' });
  await assert.rejects(asLead(app, tasks, { personalProjectId: null })({ ...line, leadAgentId: 'fla-ember' }),
    { code: 'workstream_project_required' });
  assert.deepEqual(app.standingAssignments.list(SPACE), []);
});

test('a second line for the same FLA is refused with its line named, never merged in silently', async () => {
  const { app, tasks } = fixture({ seed: [SPRING] });
  const lead = asLead(app, tasks);
  await assert.rejects(lead({ change: 'delegate', terms: ['秋促'], responsibility: '秋促落地页', leadAgentId: 'fla-ember' }),
    error => error.code === 'workstream_owner_has_line' && error.details.line.name === '春促落地页'
      && /pick another member|Bole/.test(error.message));
  assert.deepEqual(app.standingAssignments.list(SPACE).map(item => [item.responsibility, item.terms]),
    [['春促落地页', ['春促', 'spring-sale']]]);
});

test('the lead\'s own line: one-call change stays the lead\'s; never back to the lead by default', async () => {
  const { app, tasks } = fixture({ seed: [SPRING], members: { ...MEMBERS, 'fla-wren': 'Wren Ash' } });
  const lead = asLead(app, tasks);
  const moved = await lead({ change: 'reassign', term: '春促', leadAgentId: 'fla-wren' });
  assert.equal(moved.status, 'reassigned');
  assert.deepEqual(app.standingAssignments.history(lineId(app)('春促落地页')).map(item => [item.change, item.source]),
    [['registered', 'host'], ['reassigned', 'host']]);
  await assert.rejects(lead({ change: 'reassign', term: '春促' }), { code: 'workstream_owner_is_lead' });
  await assert.rejects(lead({ change: 'reassign', term: '春促', leadAgentId: LEAD }), { code: 'workstream_owner_is_lead' });
});

test('a line the person set is theirs: the lead neither extends it nor changes it in one call', async () => {
  const { app, tasks } = fixture({ seed: [{ ...SPRING, source: 'user' }] });
  const lead = asLead(app, tasks);
  await assert.rejects(lead({ change: 'delegate', terms: ['春促改版'], responsibility: '春促落地页',
    leadAgentId: 'fla-ember' }), { code: 'workstream_owner_has_line' });
  // The lead's correction of it is the person's preview-and-yes path: a digest is asked for.
  const preview = await lead({ change: 'retire', term: '春促', action: 'preview' });
  assert.equal(typeof preview.confirmationDigest, 'string');
  await assert.rejects(lead({ change: 'retire', term: '春促' }), { code: 'invalid_input' }, 'no digest, no change');
  assert.equal(app.standingAssignments.list(SPACE).length, 1);
});

// The project page (local console only).

async function api(app, method, path, body = null, { remoteAddress = '127.0.0.1' } = {}) {
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

test('the person opens a line on the project page; it is theirs, and this computer only', async () => {
  const { app } = fixture();
  const line = { personalProjectId: PROJECT, leadAgentId: 'fla-ember', terms: ['春促'], responsibility: '春促落地页' };
  const remote = await api(app, 'POST', '/api/standing-assignments', line, { remoteAddress: '192.0.2.20' });
  assert.deepEqual([remote.status, remote.body.code], [403, 'local_user_only']);
  const opened = await api(app, 'POST', '/api/standing-assignments', line);
  assert.deepEqual([opened.status, opened.body.workstream.owner_name], [200, 'Ember Vale']);
  assert.equal(app.standingAssignments.list(SPACE)[0].source, 'user');
  const second = await api(app, 'POST', '/api/standing-assignments', { ...line, terms: ['秋促'], responsibility: '秋促' });
  assert.deepEqual([second.status, second.body.code, second.body.line.name], [409, 'workstream_owner_has_line', '春促落地页']);
  const ledger = await api(app, 'GET', `/api/workstreams?personalProjectId=${PROJECT}`, null,
    { remoteAddress: '192.0.2.20' });
  assert.deepEqual([ledger.status, ledger.body.code], [403, 'local_user_only']);
});

test('merging is one change on the real store: both saved, or neither', async () => {
  const { app } = fixture({ seed: [SPRING, COUPON] });
  const id = lineId(app);
  const [spring, coupon] = [id('春促落地页'), id('优惠券中心')];
  const stale = await api(app, 'POST', `/api/standing-assignments/${coupon}/merge`,
    { into: spring, expectedRevision: 1, targetRevision: 9 });
  assert.deepEqual([stale.status, stale.body.code], [409, 'standing_assignment_changed']);
  assert.equal(app.standingAssignments.list(SPACE).length, 2, 'nothing changed');
  const merged = await api(app, 'POST', `/api/standing-assignments/${coupon}/merge`,
    { into: spring, expectedRevision: 1, targetRevision: 1 });
  assert.equal(merged.status, 200);
  const [left] = app.standingAssignments.list(SPACE);
  assert.deepEqual([left.responsibility, left.terms], ['春促落地页', ['春促', 'spring-sale', '优惠券']]);
  assert.deepEqual(app.standingAssignments.history(coupon).map(item => item.change), ['registered', 'retired']);
});

test('splitting is one change on the real store: a refused new line leaves the old one whole', async () => {
  const { app } = fixture({ seed: [{ ...SPRING, terms: ['春促', 'spring-sale', '秋促'] }, COUPON],
    members: { ...MEMBERS, 'fla-wren': 'Wren Ash' } });
  const spring = lineId(app)('春促落地页');
  // Orin already has a line, so the new line is refused, and 春促落地页 keeps 秋促.
  const refused = await api(app, 'POST', `/api/standing-assignments/${spring}/split`,
    { expectedRevision: 1, terms: ['秋促'], extraTerms: [], leadAgentId: 'fla-orin', responsibility: '秋促落地页' });
  assert.deepEqual([refused.status, refused.body.code], [409, 'workstream_owner_has_line']);
  assert.deepEqual(app.standingAssignments.get(spring).terms, ['春促', 'spring-sale', '秋促']);
  const split = await api(app, 'POST', `/api/standing-assignments/${spring}/split`,
    { expectedRevision: 1, terms: ['秋促'], extraTerms: ['autumn-sale'], leadAgentId: 'fla-wren',
      responsibility: '秋促落地页' });
  assert.equal(split.status, 200);
  assert.deepEqual(app.standingAssignments.get(spring).terms, ['春促', 'spring-sale']);
  assert.deepEqual(split.body.assignment.terms, ['秋促', 'autumn-sale']);
  assert.equal(split.body.assignment.leadAgentId, 'fla-wren');
});

test('an FLA acting for the person is recorded as an Agent and only the lead may', async () => {
  const { app } = fixture({ members: { ...MEMBERS, 'fla-wren': 'Wren Ash' } });
  const line = { personalProjectId: PROJECT, leadAgentId: 'fla-ember', terms: ['春促'], responsibility: '春促落地页' };
  const { openWorkstreamInConsole } = await import('../src/graphiti/standing-assignment-workstream.js');
  await assert.rejects(openWorkstreamInConsole(app, line, { actor: { agentId: 'fla-orin', sessionId: 's' } }),
    { code: 'workstream_lead_only' });
  const opened = await openWorkstreamInConsole(app, line, { actor: { agentId: LEAD, sessionId: 's' } });
  assert.equal(opened.status, 'created');
  assert.equal(app.standingAssignments.list(SPACE)[0].source, 'host');
});

test('a retired line stops routing, keeps every revision and leaves the ledger', async () => {
  const { app, run } = fixture({ seed: [SPRING] });
  const id = lineId(app)('春促落地页');
  app.standingAssignments.correct(id, { action: 'retire' }, { source: 'user', expectedRevision: 1 });
  assert.equal((await run({ taskPrompt: '春促 的头图' })).standing_owner, undefined);
  assert.deepEqual(app.standingAssignments.history(id).map(item => item.change), ['registered', 'retired']);
  assert.deepEqual(buildProjectTeam({ policy: { team_lead_agent_id: LEAD }, agents: [], projectId: PROJECT,
    standingAssignments: app.standingAssignments.list(SPACE) }).workstreams, []);
});
