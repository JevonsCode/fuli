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
import { policyReader, projectLeadOf } from '../src/graphiti/project-policy-read.js';
import { handoffWorkstream } from '../src/graphiti/task-entry-workstream.js';
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

const SPRING = { name: '春促落地页', terms: ['春促页', 'spring-sale'], owner: 'fla-ember' };
const RELEASES_RULE = { name: '发布与上线', terms: ['发布流程'], owner: LEAD, source: 'user' };
const COUPON = { name: '优惠券中心', terms: ['优惠券'], owner: 'fla-orin' };
const lineId = app => name => app.standingAssignments.list(SPACE).find(line => line.responsibility === name).assignmentId;

test('a matched line\'s owner is this turn\'s FLA: its own memory, task and receipt', async () => {
  const { run, tasks, requested, memoryReads } = fixture({ seed: [SPRING, COUPON] });
  const entry = await run({ taskPrompt: '春促页 的头图换一下' });
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
  // A fresh session: it takes the line over, and the notice says why.
  assert.equal(entry.standing_owner.notice, '工作线「春促落地页」由 Ember Vale 接手（因为提到「春促页」）');
  assert.equal(entry.standing_owner.reason_text, 'the request mentions "春促页"');
  assert.match(entry.agent_receipt.markdown, /Ember Vale/);
  assert.match(entry.agent_receipt.markdown, /工作线「春促落地页」由 Ember Vale 接手（因为提到「春促页」）/);
  // The task keeps which line it was, without moving its session.
  const basis = tasks.at(-1).agentAssignment.match_basis;
  assert.ok(basis.some(item => item.startsWith('workstream:')));
  assert.ok(!basis.some(item => item.startsWith('standing_assignment:') || item.startsWith('standing_session_')));
});

test('later turns of the session stay with the line quietly; a new line or owner is said once', async () => {
  const { app, run, tasks } = fixture({ seed: [SPRING, COUPON] });
  await run({ taskPrompt: '春促页 的头图换一下' });
  const next = await run({ taskPrompt: '再把按钮颜色调深一点' });
  assert.equal(next.project_agent_context.project_agent_id, 'fla-ember');
  assert.equal(tasks.at(-1).projectAgentId, 'fla-ember');
  // Same line, same owner as the session's last turn: nothing is said again,
  // and the task still counts on the line. A short field without a notice
  // keeps which line this is through a context compaction.
  assert.deepEqual(next.standing_owner, { status: 'workstream', assignment_id: lineId(app)('春促落地页'),
    workstream: '春促落地页' });
  assert.equal(next.owner_change, undefined);
  assert.doesNotMatch(next.agent_receipt.markdown, /工作线/);
  assert.deepEqual(tasks.at(-1).agentAssignment.match_basis.filter(item => item.startsWith('workstream:')),
    [`workstream:${lineId(app)('春促落地页')}`]);
  // Another line's words move the session to that line, said once, with where the earlier work is.
  const coupon = await run({ taskPrompt: '优惠券 列表空了' });
  assert.equal(coupon.project_agent_context.project_agent_id, 'fla-orin');
  assert.equal(coupon.standing_owner.notice,
    '工作线「优惠券中心」由 Orin Pike 接手（因为提到「优惠券」）；本会话之前的进展在 Ember Vale 的记录里');
  assert.equal(coupon.owner_change, undefined, 'the line\'s notice already says who changed');
});

test('a request that names the project keeps its lines', async () => {
  const { run } = fixture({ seed: [SPRING] });
  const entry = await run({ taskPrompt: 'Campaigns 的 春促页 页面改下文案' });
  assert.equal(entry.project_agent_context.project_agent_id, 'fla-ember');
});

const lineMarkers = task => task.agentAssignment.match_basis.filter(item => item.startsWith('workstream:'));

test('naming a line\'s owner: it works as itself, the turn counts on its line, and the name holds', async () => {
  const { app, run, requested, tasks } = fixture({ seed: [SPRING, COUPON] });
  const entry = await run({ taskPrompt: '#FLA Ember Vale 春促页 改一下头图' });
  assert.equal(entry.project_agent_context.project_agent_id, 'fla-ember');
  assert.equal(entry.project_agent_context.selection_reason, 'workstream_owner');
  assert.ok(requested.includes('owner:fla-ember'));
  // The ledger sees it: the turn names its line, so the task carries it, with no notice of its own.
  assert.deepEqual(lineMarkers(tasks.at(-1)), [`workstream:${lineId(app)('春促落地页')}`]);
  // The turn it is named says once that the name outranks the lines, and how back.
  assert.equal(entry.fla.notice,
    '本会话由 Ember Vale 继续项目 Campaigns 的工作；之后本会话都由它做，不再按工作线分派，发 #FLA 结束 恢复');
  // The person's name outranks the lines: another line's words do not move it.
  const later = await run({ taskPrompt: '优惠券 列表空了' });
  assert.equal(later.project_agent_context.project_agent_id, 'fla-ember');
  assert.equal(later.standing_owner, undefined);
  // Its work on another line's matter is not its line's progress.
  assert.deepEqual(lineMarkers(tasks.at(-1)), []);
  assert.doesNotMatch(later.agent_receipt.markdown, /发 #FLA 结束/, 'said once, on the turn it was named');
  // #FLA 结束 gives the session back to the lines; the named turns carry no line on.
  const released = await run({ taskPrompt: '#FLA 结束' });
  assert.equal(released.project_agent_context.project_agent_id, LEAD);
  assert.equal(released.standing_owner, undefined);
  const routed = await run({ taskPrompt: '优惠券 列表空了' });
  assert.equal(routed.project_agent_context.project_agent_id, 'fla-orin');
  // Nor is anything else it does while named.
  await run({ taskPrompt: '#FLA Ember Vale 改一下 README' });
  assert.equal(tasks.at(-1).projectAgentId, 'fla-ember');
  assert.deepEqual(lineMarkers(tasks.at(-1)), []);
  // A member without a line is still held by the lead, as before.
  const plain = fixture({ seed: [SPRING] });
  const orin = await plain.run({ taskPrompt: '#FLA Orin Pike 看看' });
  assert.equal(orin.project_agent_context.project_agent_id, LEAD);
  assert.equal(orin.project_agent_context.requested_agent_id, 'fla-orin');
});

test('two lines matching leave the task with the lead and ask once; none leaves it with the lead quietly', async () => {
  const both = fixture({ seed: [SPRING, COUPON] });
  const asked = await both.run({ taskPrompt: '春促页 的 优惠券 文案' });
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
  const onBranch = fixture({ seed: [{ ...SPRING, terms: ['春促页', 'branch:feature/spring-sale'] }],
    path: repository(t) });
  const entry = await onBranch.run({ taskPrompt: '把构建跑一下' });
  assert.equal(entry.project_agent_context.project_agent_id, 'fla-ember');
  assert.deepEqual(entry.standing_owner.matched_on, ['branch']);
  const prefix = fixture({ seed: [{ ...SPRING, terms: ['春促页', 'branch:feature/'] }], path: repository(t) });
  assert.deepEqual((await prefix.run({ taskPrompt: '把构建跑一下' })).standing_owner.matched_on, ['branch']);
  assert.throws(() => createStandingAssignments().register({ personalSpaceId: SPACE, projectId: PROJECT,
    leadAgentId: 'fla-ember', terms: ['branch:main'], responsibility: 'x', source: 'host' }),
  { code: 'standing_assignment_term_too_broad' });
  assert.throws(() => createStandingAssignments().register({ personalSpaceId: SPACE, projectId: PROJECT,
    leadAgentId: 'fla-ember', terms: ['branch:develop'], responsibility: 'x', source: 'host' }),
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
  const entry = await run({ taskPrompt: '春促页 的头图换一下' });
  assert.equal(entry.project_agent_context.project_agent_id, LEAD);
  assert.equal(entry.standing_owner.owner_resolved, false);
  assert.equal(entry.standing_owner.reason, 'workstream_owner_not_on_project');
  assert.equal(entry.standing_owner.notice,
    '工作线「春促落地页」（因为提到「春促页」）的负责人 Fern Holt 已不在本项目，这次由 Mara Quill 处理；可在项目页把这条线交给别人');
});

test('the lead sees the lines as facts and the rule by reference; a project without lines carries neither', async () => {
  const divided = fixture({ seed: [SPRING, COUPON] });
  const team = await loadProjectTeamContext(divided.app, SPACE, PROJECT, { agentId: LEAD });
  assert.deepEqual(team.workstreams.map(line => [line.workstream, line.owner_name]).sort(),
    [['优惠券中心', 'Orin Pike'], ['春促落地页', 'Ember Vale']]);
  assert.match(team.workstream_guidance, /begin_task_context with workKind "workstream:<its name>"/);
  assert.match(team.workstream_guidance, /only when that entry returns workstream_handoff\.status handed_over/);
  assert.match(team.workstream_guidance, /never #FLA/);
  // Only the lead divides the project: an owner or a member sees the lines, never the rule.
  for (const agentId of ['fla-ember', 'fla-orin', null]) {
    const member = await loadProjectTeamContext(divided.app, SPACE, PROJECT, { agentId });
    assert.equal(member.workstreams.length, 2);
    assert.equal(member.workstream_guidance, undefined, String(agentId));
  }
  const undivided = await loadProjectTeamContext(fixture().app, SPACE, PROJECT, { agentId: LEAD });
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

test('the lead opens a line in one call, recorded as the lead\'s, with only the terms it named', async () => {
  const { app, tasks } = fixture();
  const lead = asLead(app, tasks);
  const result = await lead({ change: 'delegate', terms: ['春促页', 'spring-sale'], responsibility: '春促落地页',
    leadAgentId: 'fla-ember' });
  assert.equal(result.status, 'created');
  // The session's branch is never added on its own.
  assert.deepEqual(result.workstream.terms, ['春促页', 'spring-sale']);
  assert.equal(result.workstream.branches, undefined);
  // The lead is told what to pass on to the person.
  assert.equal(result.tell_user, '已开工作线「春促落地页」交给 Ember Vale，词：春促页、spring-sale');
  assert.match(result.notice, /Tell the person tell_user once/);
  const [stored] = app.standingAssignments.list(SPACE);
  assert.deepEqual([stored.projectId, stored.leadAgentId, stored.source, stored.terms],
    [PROJECT, 'fla-ember', 'host', ['春促页', 'spring-sale']]);
});

test('a branch the lead names is a term, listed apart in the preview and the result', async () => {
  const { app, tasks } = fixture();
  const lead = asLead(app, tasks);
  const line = { change: 'delegate', terms: ['优惠券', 'branch:perf/'], responsibility: '优惠券中心',
    leadAgentId: 'fla-orin' };
  const preview = await lead({ ...line, action: 'preview' });
  assert.deepEqual([preview.workstream.terms, preview.workstream.branches], [['优惠券'], ['perf/']]);
  assert.match(preview.restatement, /Every task on the branch "perf\/" goes there too/);
  const created = await lead(line);
  assert.deepEqual([created.workstream.terms, created.workstream.branches], [['优惠券'], ['perf/']]);
  assert.equal(created.tell_user, '已开工作线「优惠券中心」交给 Orin Pike，词：优惠券；分支：perf/');
});

test('opening a line is refused for the lead, a stranger, another Agent, no project and a too-broad word', async () => {
  const { app, tasks } = fixture();
  const lead = asLead(app, tasks);
  const line = { change: 'delegate', terms: ['春促页'], responsibility: '春促落地页' };
  await assert.rejects(lead({ ...line, leadAgentId: LEAD }), { code: 'workstream_owner_is_lead' });
  await assert.rejects(lead({ ...line, leadAgentId: 'fla-unknown' }), { code: 'workstream_owner_not_in_project' });
  // Two Han characters match requests about anything; an Agent needs three.
  for (const term of ['页面', '春', 'ab', 'admin', '性能', '上线']) {
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
  await assert.rejects(lead({ change: 'delegate', terms: ['秋促页'], responsibility: '秋促落地页', leadAgentId: 'fla-ember' }),
    error => error.code === 'workstream_owner_has_line' && error.details.line.name === '春促落地页'
      && /pick another member|Bole/.test(error.message));
  assert.deepEqual(app.standingAssignments.list(SPACE).map(item => [item.responsibility, item.terms]),
    [['春促落地页', ['春促页', 'spring-sale']]]);
});

test('the lead\'s own line: one-call change stays the lead\'s; never back to the lead by default', async () => {
  const { app, tasks } = fixture({ seed: [SPRING], members: { ...MEMBERS, 'fla-wren': 'Wren Ash' } });
  const lead = asLead(app, tasks);
  const moved = await lead({ change: 'reassign', term: '春促页', leadAgentId: 'fla-wren' });
  assert.equal(moved.status, 'reassigned');
  assert.deepEqual(app.standingAssignments.history(lineId(app)('春促落地页')).map(item => [item.change, item.source]),
    [['registered', 'host'], ['reassigned', 'host']]);
  await assert.rejects(lead({ change: 'reassign', term: '春促页' }), { code: 'workstream_owner_is_lead' });
  await assert.rejects(lead({ change: 'reassign', term: '春促页', leadAgentId: LEAD }), { code: 'workstream_owner_is_lead' });
});

test('a line the person set is theirs: the lead neither extends it nor changes it in one call', async () => {
  const { app, tasks } = fixture({ seed: [{ ...SPRING, source: 'user' }] });
  const lead = asLead(app, tasks);
  await assert.rejects(lead({ change: 'delegate', terms: ['春促改版'], responsibility: '春促落地页',
    leadAgentId: 'fla-ember' }), { code: 'workstream_owner_has_line' });
  // The lead's correction of it is the person's preview-and-yes path: a digest is asked for.
  const preview = await lead({ change: 'retire', term: '春促页', action: 'preview' });
  assert.equal(typeof preview.confirmationDigest, 'string');
  await assert.rejects(lead({ change: 'retire', term: '春促页' }), { code: 'invalid_input' }, 'no digest, no change');
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
  const line = { personalProjectId: PROJECT, leadAgentId: 'fla-ember', terms: ['春促页'], responsibility: '春促落地页' };
  const remote = await api(app, 'POST', '/api/standing-assignments', line, { remoteAddress: '192.0.2.20' });
  assert.deepEqual([remote.status, remote.body.code], [403, 'local_user_only']);
  const opened = await api(app, 'POST', '/api/standing-assignments', line);
  assert.deepEqual([opened.status, opened.body.workstream.owner_name], [200, 'Ember Vale']);
  assert.equal(app.standingAssignments.list(SPACE)[0].source, 'user');
  const second = await api(app, 'POST', '/api/standing-assignments', { ...line, terms: ['秋促页'], responsibility: '秋促页' });
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
  assert.deepEqual([left.responsibility, left.terms], ['春促落地页', ['春促页', 'spring-sale', '优惠券']]);
  assert.deepEqual(app.standingAssignments.history(coupon).map(item => item.change), ['registered', 'retired']);
});

test('splitting is one change on the real store: a refused new line leaves the old one whole', async () => {
  const { app } = fixture({ seed: [{ ...SPRING, terms: ['春促页', 'spring-sale', '秋促页'] }, COUPON],
    members: { ...MEMBERS, 'fla-wren': 'Wren Ash' } });
  const spring = lineId(app)('春促落地页');
  // Orin already has a line, so the new line is refused, and 春促落地页 keeps 秋促.
  const refused = await api(app, 'POST', `/api/standing-assignments/${spring}/split`,
    { expectedRevision: 1, terms: ['秋促页'], extraTerms: [], leadAgentId: 'fla-orin', responsibility: '秋促落地页' });
  assert.deepEqual([refused.status, refused.body.code], [409, 'workstream_owner_has_line']);
  assert.deepEqual(app.standingAssignments.get(spring).terms, ['春促页', 'spring-sale', '秋促页']);
  const split = await api(app, 'POST', `/api/standing-assignments/${spring}/split`,
    { expectedRevision: 1, terms: ['秋促页'], extraTerms: ['autumn-sale'], leadAgentId: 'fla-wren',
      responsibility: '秋促落地页' });
  assert.equal(split.status, 200);
  assert.deepEqual(app.standingAssignments.get(spring).terms, ['春促页', 'spring-sale']);
  assert.deepEqual(split.body.assignment.terms, ['秋促页', 'autumn-sale']);
  assert.equal(split.body.assignment.leadAgentId, 'fla-wren');
});

test('an FLA acting for the person is recorded as an Agent and only the lead may', async () => {
  const { app } = fixture({ members: { ...MEMBERS, 'fla-wren': 'Wren Ash' } });
  const line = { personalProjectId: PROJECT, leadAgentId: 'fla-ember', terms: ['春促页'], responsibility: '春促落地页' };
  const { openWorkstreamInConsole } = await import('../src/graphiti/standing-assignment-workstream.js');
  await assert.rejects(openWorkstreamInConsole(app, line, { actor: { agentId: 'fla-orin', sessionId: 's' } }),
    { code: 'workstream_lead_only' });
  const opened = await openWorkstreamInConsole(app, line, { actor: { agentId: LEAD, sessionId: 's' } });
  assert.equal(opened.status, 'created');
  assert.equal(app.standingAssignments.list(SPACE)[0].source, 'host');
});

test('a retired line stops routing, keeps every revision and is listed as ended', async () => {
  const { app, run } = fixture({ seed: [SPRING, RELEASES_RULE] });
  const rule = lineId(app)('发布与上线');
  app.standingAssignments.correct(rule, { action: 'retire' }, { source: 'user', expectedRevision: 1 });
  const id = lineId(app)('春促落地页');
  app.standingAssignments.correct(id, { action: 'retire' }, { source: 'user', expectedRevision: 1 });
  assert.equal((await run({ taskPrompt: '春促页 的头图' })).standing_owner, undefined);
  assert.deepEqual(app.standingAssignments.history(id).map(item => item.change), ['registered', 'retired']);
  assert.deepEqual(buildProjectTeam({ policy: { team_lead_agent_id: LEAD }, agents: [], projectId: PROJECT,
    standingAssignments: app.standingAssignments.list(SPACE) }).workstreams, []);
  // The project page lists it as ended; the person's ended rule for the lead is no line.
  const { closed } = await projectWorkstreamLedger(app, SPACE, PROJECT);
  assert.deepEqual(closed.map(line => [line.name, line.ownerName, line.terms]), [['春促落地页', 'Ember Vale', ['春促页', 'spring-sale']]]);
  assert.equal(typeof closed[0].endedAt, 'string');
});

// The person's rule for the lead, the lead's hand-off and what a later change
// to a line does to a session on it (review of #1063).

test('the person\'s rule for the lead is no line: the session goes back to the lead and says so', async () => {
  const { run } = fixture({ seed: [SPRING, COUPON, RELEASES_RULE] });
  assert.equal((await run({ taskPrompt: '春促页 的头图换一下' })).project_agent_context.project_agent_id, 'fla-ember');
  const back = await run({ taskPrompt: '发布流程确认一下' });
  assert.equal(back.project_agent_context.project_agent_id, LEAD);
  // Not two lines to choose from, and the change of FLA is said.
  assert.equal(back.standing_owner, undefined);
  assert.equal(back.owner_change.from_agent_id, 'fla-ember');
  assert.equal(back.owner_change.to_agent_id, LEAD);
  assert.match(back.agent_receipt.markdown, /本会话上一个任务由 Ember Vale 负责，这次起由 Mara Quill 负责/);
  // A line's words beside the rule's are that line, never a choice between the two.
  const both = fixture({ seed: [SPRING, RELEASES_RULE] });
  const line = await both.run({ taskPrompt: '春促页 的发布流程' });
  assert.equal(line.project_agent_context.project_agent_id, 'fla-ember');
  assert.notEqual(line.standing_owner.status, 'clarification_required');
});

test('the lead hands a task to a line by name: no #FLA binding, and the line carries the session on', async () => {
  const { app, run, tasks } = fixture({ seed: [SPRING, COUPON] });
  await run({ taskPrompt: '看一下这个页面' });
  assert.equal(tasks.at(-1).projectAgentId, LEAD);
  const handed = await run({ taskPrompt: '头图换成春天的', workstream: '春促落地页' });
  assert.equal(handed.project_agent_context.project_agent_id, 'fla-ember');
  assert.deepEqual(handed.workstream_handoff, { status: 'handed_over', workstream: '春促落地页' });
  assert.equal(handed.project_agent_context.selection_reason, 'workstream_owner');
  assert.deepEqual(handed.standing_owner.matched_on, ['handoff']);
  assert.equal(handed.standing_owner.notice,
    '工作线「春促落地页」由 Ember Vale 接手（组长交给它）；本会话之前的进展在组长的记录里');
  const basis = tasks.at(-1).agentAssignment.match_basis;
  assert.ok(basis.some(item => item.startsWith(`workstream:${lineId(app)('春促落地页')} `)));
  assert.ok(!basis.some(item => item.startsWith('fla_binding:')), 'the lead\'s hand-off binds nothing');
  // The person's next words decide as lines do: another line's words move it.
  const quiet = await run({ taskPrompt: '再亮一点' });
  assert.equal(quiet.project_agent_context.project_agent_id, 'fla-ember');
  assert.equal(quiet.standing_owner.notice, undefined);
  assert.equal(quiet.workstream_handoff, undefined);
  assert.equal((await run({ taskPrompt: '优惠券 列表空了' })).project_agent_context.project_agent_id, 'fla-orin');
  // The same through begin_task_context, the call the guidance names: the
  // hand-off rides on workKind, which then scopes nothing.
  const begun = fixture({ seed: [SPRING] });
  await begun.run({ taskPrompt: '看一下这个页面' });
  const entry = await begun.app.beginTaskContext({ sessionId: 'synthetic-session', turnId: 'turn-1',
    projectPath: '/synthetic/campaigns', sourceApplication: 'codex', taskPrompt: '头图换成春天的',
    workKind: 'workstream:春促落地页' });
  assert.equal(begun.tasks.at(-1).projectAgentId, 'fla-ember');
  assert.equal(entry.workstream_handoff.status, 'handed_over');
  assert.notEqual(begun.tasks.at(-1).preferenceScope?.work_kind, 'workstream:春促落地页');
  assert.equal(handoffWorkstream('implementation'), null);
  assert.equal(handoffWorkstream('workstream: 春促落地页 '), '春促落地页');
});

const STILL_YOURS = /the task is still yours|so the task is still yours/;

test('a hand-off that does not happen is always said, with why, and the task stays with its caller', async () => {
  const notDone = (entry, status, reason) => {
    assert.deepEqual([entry.workstream_handoff?.status, entry.workstream_handoff?.reason], [status, reason]);
    assert.match(entry.workstream_handoff.guidance, STILL_YOURS);
  };
  // No line by that name, or one that was closed.
  const unknown = fixture({ seed: [SPRING, COUPON] });
  await unknown.run();
  const missing = await unknown.run({ taskPrompt: '头图', workstream: '秋促落地页' });
  assert.equal(missing.project_agent_context.project_agent_id, LEAD);
  assert.equal(missing.workstream_handoff.workstream, '秋促落地页');
  notDone(missing, 'workstream_not_found', 'no_such_workstream');
  unknown.app.standingAssignments.correct(lineId(unknown.app)('优惠券中心'), { action: 'retire' },
    { source: 'user', expectedRevision: 1 });
  const closed = await unknown.run({ taskPrompt: '列表空了', workstream: '优惠券中心' });
  assert.equal(closed.project_agent_context.project_agent_id, LEAD);
  notDone(closed, 'workstream_not_found', 'no_such_workstream');
  // A project without lines says so too, and still reads no lead for it.
  const plain = fixture();
  let policyReads = 0;
  plain.app.personal.getProjectAgentCoordinationPolicy = async () => { policyReads += 1; return { team_lead_agent_id: LEAD }; };
  await plain.run();
  notDone(await plain.run({ taskPrompt: '头图', workstream: '春促落地页' }), 'workstream_not_found', 'no_workstreams');
  assert.equal(policyReads, 0);
  // The person's #FLA binding outranks it: the named FLA keeps the turn.
  const bound = fixture({ seed: [SPRING, COUPON] });
  await bound.run({ taskPrompt: '#FLA Ember Vale 看看' });
  const held = await bound.run({ taskPrompt: '列表空了', workstream: '优惠券中心' });
  assert.equal(held.project_agent_context.project_agent_id, 'fla-ember');
  notDone(held, 'workstream_handoff_held', 'named_fla');
  // So does a #FLA in the same request, and an explicit Agent.
  const said = fixture({ seed: [SPRING] });
  await said.run();
  notDone(await said.run({ taskPrompt: '#FLA Orin Pike 看看', workstream: '春促落地页' }),
    'workstream_handoff_held', 'named_fla');
  const explicit = fixture({ seed: [SPRING] });
  await explicit.run();
  const pinned = await explicit.run({ taskPrompt: '头图', projectAgentId: LEAD, workstream: '春促落地页' });
  assert.equal(pinned.project_agent_context.project_agent_id, LEAD);
  notDone(pinned, 'workstream_handoff_held', 'explicit_agent');
  // An owner who left the project cannot take it: the lead keeps it, never handed_over.
  const left = fixture({ seed: [{ ...SPRING, owner: 'fla-former' }] });
  await left.run();
  const gone = await left.run({ taskPrompt: '头图', workstream: '春促落地页' });
  assert.equal(gone.project_agent_context.project_agent_id, LEAD);
  notDone(gone, 'workstream_handoff_held', 'workstream_owner_not_on_project');
});

test('only the lead hands work over: an owner or a worker asking is refused and keeps its turn', async () => {
  // A line's owner, on its own line, asks to hand to another line.
  const { app, run, tasks } = fixture({ seed: [SPRING, COUPON] });
  await run({ taskPrompt: '春促页 的头图换一下' });
  const owner = await run({ taskPrompt: '列表也看看', workstream: '优惠券中心' });
  assert.equal(owner.project_agent_context.project_agent_id, 'fla-ember');
  assert.deepEqual([owner.workstream_handoff.status, owner.workstream_handoff.reason],
    ['workstream_handoff_refused', 'not_lead']);
  assert.match(owner.workstream_handoff.guidance, /Only the project lead/);
  assert.deepEqual(lineMarkers(tasks.at(-1)), [`workstream:${lineId(app)('春促落地页')}`]);
  // A worker of the project (no line of its own) whose task the session holds.
  const worker = fixture({ seed: [SPRING], members: { ...MEMBERS, 'fla-wren': 'Wren Ash' } });
  worker.tasks.push({ token: 'fuli-task-synthetic-worker', sessionId: 'synthetic-session', personalProjectId: PROJECT,
    projectAgentId: 'fla-wren', sourceApplication: 'codex', agentAssignment: { match_basis: [] } });
  const refused = await worker.run({ taskPrompt: '头图', workstream: '春促落地页' });
  assert.notEqual(refused.project_agent_context.project_agent_id, 'fla-ember');
  assert.deepEqual(worker.requested, [null], 'no owner was asked for');
  assert.equal(refused.workstream_handoff.status, 'workstream_handoff_refused');
});

test('#FLA 结束 with a request releases the name and routes the request by its lines', async () => {
  const { run } = fixture({ seed: [SPRING, COUPON] });
  await run({ taskPrompt: '#FLA Ember Vale 看看' });
  const released = await run({ taskPrompt: '#FLA 结束 优惠券 列表空了' });
  assert.equal(released.fla.status, 'released');
  assert.equal(released.project_agent_context.project_agent_id, 'fla-orin');
  assert.match(released.standing_owner.notice, /工作线「优惠券中心」由 Orin Pike 接手（因为提到「优惠券」）/);
  // An FLA whose name starts with the word is still that FLA.
  const named = fixture({ seed: [SPRING], members: { ...MEMBERS, 'fla-end': 'End Rivers' } });
  const ender = await named.run({ taskPrompt: '#FLA End Rivers 看看' });
  assert.notEqual(ender.fla?.status, 'released');
  assert.equal(named.tasks.at(-1).agentAssignment.match_basis.some(item => item.startsWith('fla_binding:fla-end ')), true);
});

test('one entry reads the project\'s lead once, shared by the routing and the team block', async () => {
  const { app, run } = fixture({ seed: [SPRING, COUPON] });
  let reads = 0;
  const read = app.personal.getProjectAgentCoordinationPolicy;
  app.personal.getProjectAgentCoordinationPolicy = async (...args) => { reads += 1; return read(...args); };
  await run({ taskPrompt: '春促页 的头图换一下' });
  assert.equal(reads, 1);
  reads = 0;
  await run({ taskPrompt: '#FLA Orin Pike 看看' });
  assert.equal(reads, 1, 'the named turn\'s notice reads it once');
  reads = 0;
  const readPolicy = policyReader(app);
  assert.equal(await projectLeadOf(readPolicy, PROJECT), LEAD);
  const team = await loadProjectTeamContext(app, SPACE, PROJECT, { agentId: LEAD, readPolicy });
  assert.equal(team.lead_agent_id, LEAD);
  assert.equal(reads, 1);
});

test('a line\'s words outrank another line\'s folder: no question is asked', async t => {
  const root = repository(t, 'main');
  const { run } = fixture({ seed: [SPRING, COUPON], path: join(root, 'apps', 'spring-sale') });
  const entry = await run({ taskPrompt: '优惠券 列表空了' });
  assert.equal(entry.project_agent_context.project_agent_id, 'fla-orin');
  assert.deepEqual(entry.standing_owner.matched_on, ['words']);
  // Without words, the folder decides, and the notice says it.
  const folder = await run({ taskPrompt: '把构建跑一下' });
  assert.equal(folder.project_agent_context.project_agent_id, 'fla-ember');
  assert.match(folder.standing_owner.notice, /（因为在目录 spring-sale 下）/);
});

test('a line given to someone else: the new owner takes it over and is told where the earlier work is', async () => {
  const { app, run } = fixture({ seed: [SPRING], members: { ...MEMBERS, 'fla-wren': 'Wren Ash' } });
  await run({ taskPrompt: '春促页 的头图换一下' });
  app.standingAssignments.correct(lineId(app)('春促落地页'), { action: 'reassign', projectId: PROJECT,
    leadAgentId: 'fla-wren' }, { source: 'user', expectedRevision: 1 });
  const next = await run({ taskPrompt: '再把按钮颜色调深一点' });
  assert.equal(next.project_agent_context.project_agent_id, 'fla-wren');
  assert.equal(next.standing_owner.notice,
    '工作线「春促落地页」由 Wren Ash 接手（延续本会话上一轮）；本会话之前的进展在 Ember Vale 的记录里');
});

test('a line merged into another: the session goes on with the line it went into', async () => {
  const { app, run } = fixture({ seed: [SPRING, COUPON] });
  await run({ taskPrompt: '优惠券 列表空了' });
  const id = lineId(app);
  app.standingAssignments.merge(id('优惠券中心'), id('春促落地页'), { source: 'user', expectedRevision: 1,
    targetRevision: 1 });
  const next = await run({ taskPrompt: '再看一下' });
  assert.equal(next.project_agent_context.project_agent_id, 'fla-ember');
  assert.deepEqual(next.standing_owner.matched_on, ['session']);
});

test('the person may still use a two-character word; an Agent may not', () => {
  const port = createStandingAssignments();
  const line = { personalSpaceId: SPACE, projectId: PROJECT, leadAgentId: 'fla-ember', terms: ['性能'],
    responsibility: '性能' };
  assert.throws(() => port.open({ ...line, source: 'host' }), { code: 'standing_assignment_term_too_broad' });
  assert.equal(port.open({ ...line, source: 'user' }).status, 'created');
});
