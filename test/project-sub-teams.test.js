import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProjectTeam } from '../src/graphiti/project-team-view.js';
import { loadProjectTeamContext, TEAM_GUIDANCE } from '../src/graphiti/project-agent-team-context.js';
import { projectAgentCoordinationPolicyRecord, providerProjectAgentCoordinationPolicy } from '../src/graphiti/project-agent-mapping.js';

const group = { id: 'backend', name: 'Backend', lead_agent_id: 'sub', member_agent_ids: ['member'] };
const policy = { team_lead_agent_id: 'lead', team_member_agent_ids: ['sub', 'member', 'other'], sub_teams: [group] };
const assigned = (agent_id, status = 'active') => ({ agent_id, profile: { name: agent_id, status },
  assignments: [{ personal_project_id: 'project', status: 'active' }], privateMemory: 'do not expose' });
const agents = ['lead', 'sub', 'member', 'other'].map(id => assigned(id));

test('policy maps the exact project-local layout both ways without sending omitted fields', () => {
  const dto = projectAgentCoordinationPolicyRecord({ ...policy, sub_team_suggestion_threshold: 8 });
  assert.deepEqual(dto.subTeams, [{ id: 'backend', name: 'Backend', leadAgentId: 'sub', memberAgentIds: ['member'] }]);
  assert.equal(dto.subTeamSuggestionThreshold, 8);
  const write = providerProjectAgentCoordinationPolicy(dto);
  assert.deepEqual(write.sub_teams, [group]);
  assert.equal(write.sub_team_suggestion_threshold, 8);
  const legacy = providerProjectAgentCoordinationPolicy({ personalSpaceId: 'space', personalProjectId: 'project' });
  assert.equal(Object.hasOwn(legacy, 'sub_teams'), false);
});

test('team projection and entry context preserve immediate parents and one user-facing owner', async () => {
  const team = buildProjectTeam({ projectId: 'project', policy, agents });
  assert.deepEqual(team.members.map(x => [x.agentId, x.reportsToAgentId]),
    [['sub', 'lead'], ['member', 'sub'], ['other', 'lead']]);
  assert.equal(team.subTeams[0].lead.agentId, 'sub');
  assert.deepEqual(team.subTeams[0].members.map(x => x.agentId), ['member']);
  const context = await loadProjectTeamContext({ personal: {
    getProjectAgentCoordinationPolicy: async () => policy, listProjectAgents: async () => agents
  } }, 'space', 'project');
  assert.equal(context.user_facing_agent_id, 'lead');
  assert.deepEqual(context.reporting_lines, [{ agent_id: 'sub', reports_to_agent_id: 'lead' },
    { agent_id: 'member', reports_to_agent_id: 'sub' }, { agent_id: 'other', reports_to_agent_id: 'lead' }]);
  assert.equal(context.roster.find(x => x.agent_id === 'sub').role, 'sub_lead');
  assert.match(TEAM_GUIDANCE, /immediate reporting lead/);
  assert.doesNotMatch(TEAM_GUIDANCE, /Members report results and blockers to this lead/);
  assert.doesNotMatch(JSON.stringify(context), /do not expose/);
});

test('unavailable sub-lead is explicit and never silently promotes its members', () => {
  const team = buildProjectTeam({ projectId: 'project', policy,
    agents: agents.map(x => x.agent_id === 'sub' ? assigned('sub', 'archived') : x) });
  assert.equal(team.subTeams[0].lead, null);
  assert.equal(team.subTeams[0].unavailableLead.agentId, 'sub');
  assert.equal(team.members.find(x => x.agentId === 'member').reportsToAgentId, 'sub');
});

test('large team only suggests sub-leads at the configured threshold and never changes the layout', () => {
  const value = { team_lead_agent_id: 'lead', team_member_agent_ids: ['sub', 'member', 'other'], sub_team_suggestion_threshold: 2 };
  const before = structuredClone(value);
  const team = buildProjectTeam({ projectId: 'project', policy: value, agents });
  assert.deepEqual(team.subTeamSuggestion, { suggested: true, memberCount: 3, threshold: 2 });
  assert.deepEqual(value, before);
  assert.equal(buildProjectTeam({ projectId: 'project', policy: { ...value, sub_teams: [group] }, agents })
    .subTeamSuggestion.suggested, false);
});

test('planning dispatches through the sub-lead and rejects another branch', async () => {
  const { dispatchTarget } = await import('../src/graphiti/project-team-hierarchy.js');
  assert.equal(dispatchTarget(policy, 'lead', 'member'), 'sub');
  assert.equal(dispatchTarget(policy, 'sub', 'member'), 'member');
  assert.equal(dispatchTarget(policy, 'sub', 'other'), null);
  assert.equal(dispatchTarget(policy, 'lead', 'other'), 'other');
});

test('the public grouped staffing tool requires a schema-declared token bound to this host', async () => {
  const { callAgentTool, listAgentTools } = await import('../src/agent-tools.js');
  const { submitProjectAgentTask } = await import('../src/graphiti/project-agent-workflows.js');
  const { prepareDirectAgentToolCall } = await import('../src/mcp/direct-call.js');
  const schema = listAgentTools().find(tool => tool.name === 'submit_project_agent_task').inputSchema;
  assert.equal(schema.properties.taskContextToken.type, 'string');
  const native = '11111111-2222-4333-8444-555555555555';
  let writes = 0;
  const app = { personal: { getProjectAgentCoordinationPolicy: async () => policy,
    submitProjectAgentTask: async () => { writes++; throw new Error('provider-reached'); } },
    taskContextRegistry: { context: async () => ({ personalProjectId: 'project', sessionId: native }) } };
  app.submitProjectAgentTask = input => submitProjectAgentTask(app, input);
  const input = { personalSpaceId: 'space', personalProjectId: 'project', idempotencyKey: 'synthetic-task',
    title: 'Synthetic staffing', objective: 'Check authenticated caller', workKind: 'implementation',
    routingReason: 'Synthetic boundary only', sourceApplication: 'codex', sourceSessionId: native };
  await assert.rejects(callAgentTool(app, 'submit_project_agent_task', { ...input, agentInvocation: false }), /current taskContextToken/);
  await assert.rejects(callAgentTool(app, 'submit_project_agent_task', { ...input,
    taskContextToken: 'synthetic', sourceSessionId: 'foreign-session' }), /this host session/);
  assert.equal(writes, 0);
  const prepared = await prepareDirectAgentToolCall({ toolName: 'submit_project_agent_task',
    input: { ...input, taskContextToken: 'synthetic' }, sourceApplication: 'codex', env: { CODEX_THREAD_ID: native } });
  await assert.rejects(callAgentTool(app, 'submit_project_agent_task', prepared.input), /provider-reached/);
  assert.equal(writes, 1);
});

test('real planning port routes root work through the sub-lead and sub-lead work to its own member', async () => {
  const { planAgentCollaboration } = await import('../src/graphiti/agent-collaboration.js');
  const directory = agents.map(value => ({ ...value, assignments: value.assignments.map(a => ({ ...a,
    work_kinds: value.agent_id === 'member' ? ['implementation'] : ['planning'] })),
    profile: { ...value.profile, allowed_clients: ['codex'] } }));
  let current = 'lead';
  const app = { config: { personal: { spaceId: 'space' } },
    taskContextRegistry: { context: async () => ({ projectAgentId: current, personalProjectId: 'project' }) },
    personal: { listProjectAgents: async () => directory, getProjectAgentCoordinationPolicy: async () => policy,
      agentLoan: async () => ({ loans: [] }) }, listExecutors: async () => [], listExecutorRoutingRules: async () => [],
    getProjectAgent: async () => ({ profile: {} }) };
  const input = { taskContextToken: 'synthetic', sourceApplication: 'codex', workKind: 'implementation', taskSize: 'small' };
  let plan = await planAgentCollaboration(app, input);
  let stream = plan.divisionPlan.workstreams[0];
  assert.equal(stream.agentId, 'sub');
  assert.equal(stream.dispatch.arguments.leadAgentId, 'sub');
  assert.equal(stream.dispatch.arguments.workKind, 'delegation');
  assert.equal(plan.candidates[0].nextSteps.ask.arguments.to, 'sub');
  assert.equal(plan.candidates[0].nextSteps.execute.arguments.leadAgentId, 'sub');
  assert.equal(plan.candidates[0].nextSteps.execute.arguments.coordinatorAgentId, 'lead');
  assert.equal(plan.candidates[0].nextSteps.execute.arguments.workKind, 'delegation');
  assert.equal(Object.hasOwn(plan.candidates[0].nextSteps.execute.arguments, 'collaboratorAgentIds'), false);
  current = 'sub';
  stream = (await planAgentCollaboration(app, input)).divisionPlan.workstreams[0];
  assert.equal(stream.agentId, 'member');
  assert.equal(stream.dispatch.arguments.coordinatorAgentId, 'sub');
  const gap = await planAgentCollaboration(app, { ...input, workKind: 'absent-kind' });
  assert.equal(gap.divisionPlan.workstreams[0].action, 'blocked');
  assert.equal(gap.divisionPlan.workstreams[0].blockedReason, 'sub_team_scope_gap');
  assert.equal(gap.divisionPlan.workstreams[0].dispatch, null);
  assert.equal(gap.recruitment, null);
  current = 'member';
  const memberGap = await planAgentCollaboration(app, { ...input, workKind: 'absent-kind' });
  assert.equal(memberGap.divisionPlan.workstreams[0].action, 'blocked');
  assert.equal(memberGap.divisionPlan.workstreams[0].reportToAgentId, 'sub');
  current = 'lead';
  directory.find(agent => agent.agent_id === 'sub').profile.allowed_clients = ['claude_code'];
  plan = await planAgentCollaboration(app, input);
  assert.equal(plan.divisionPlan.workstreams[0].action, 'blocked');
  assert.equal(plan.divisionPlan.workstreams[0].dispatch, null);
});
