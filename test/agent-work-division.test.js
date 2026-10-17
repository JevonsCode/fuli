import test from 'node:test';
import assert from 'node:assert/strict';
import { planAgentCollaboration } from '../src/graphiti/agent-collaboration.js';

const agent = (id, kinds, project = 'sample') => ({ agent_id: id,
  profile: { name: id, allowed_clients: ['codex'], work_kinds: kinds },
  assignments: [{ personal_project_id: project, status: 'active', work_kinds: kinds }] });
function fixture(agents) {
  let reads = 0;
  return { config: { personal: { spaceId: 'space' } },
    taskContextRegistry: { context: async () => ({ projectAgentId: 'lead', personalProjectId: 'sample' }) },
    personal: { listProjectAgents: async () => { reads++; return agents; },
      getProjectAgentCoordinationPolicy: async (_s, project) => ({ team_lead_agent_id: project === 'sample' ? 'lead' : 'source-lead' }),
      agentLoan: async () => ({ loans: [] }) },
    listExecutors: async () => [], listExecutorRoutingRules: async () => [],
    getProjectAgent: async () => ({ profile: {} }), reads: () => reads };
}
const input = { taskContextToken: 'task', sourceApplication: 'codex', workKind: 'implementation' };
const team = () => [agent('lead', ['implementation', 'test_validation']),
  agent('developer', ['implementation', 'test_validation']), agent('qa', ['test_validation'])];

test('standard work reuses the main FLA and assigns a different FLA to acceptance after artifacts exist', async () => {
  const app = fixture(team());
  const result = await planAgentCollaboration(app, input);
  const plan = result.divisionPlan;
  assert.equal(plan.mode, 'separated');
  assert.equal(plan.coordinatorAgentId, 'lead');
  assert.equal(plan.workstreams.length, 2);
  assert.equal(plan.workstreams[0].agentId, 'lead');
  assert.equal(plan.workstreams[0].action, 'continue_current');
  const qa = plan.workstreams[1];
  assert.notEqual(qa.agentId, 'lead');
  assert.deepEqual(qa.dependsOn, ['main']);
  assert.equal(qa.startWhen, 'artifacts_ready');
  assert.equal(qa.dispatch.arguments.leadAgentId, qa.agentId);
  assert.equal(qa.dispatch.arguments.coordinatorAgentId, 'lead');
  assert.equal(qa.dispatch.arguments.personalProjectId, 'sample');
  assert.equal(qa.dispatch.arguments.contextLimitPerQuery, 3);
  assert.equal(plan.contextPolicy.inheritConversation, false);
  assert.equal(app.reads(), 1, 'planning reuses one roster and invokes no model');
  assert.equal(result.executionStarted, false);
});

test('small work stays together without a new worker or recruitment', async () => {
  const result = await planAgentCollaboration(fixture([team()[0]]), { ...input, taskSize: 'small' });
  assert.equal(result.divisionPlan.mode, 'single');
  assert.equal(result.divisionPlan.workstreams.length, 1);
  assert.equal(result.divisionPlan.workstreams[0].action, 'continue_current');
  assert.equal(result.divisionPlan.workstreams[0].dispatch, null);
});

test('running one existing test command is small work, not a new independent acceptance worker', async () => {
  const result = await planAgentCollaboration(fixture([team()[0]]), { ...input,
    workKind: 'test_validation', taskSize: 'small' });
  assert.equal(result.divisionPlan.workstreams.length, 1);
  assert.equal(result.divisionPlan.workstreams[0].action, 'continue_current');
  assert.equal(result.divisionPlan.workstreams[0].agentId, 'lead');
  assert.equal(result.divisionPlan.workstreams[0].dispatch, null);
});

test('complex work adds only one explicit independent scope and excludes all authors from acceptance', async () => {
  const result = await planAgentCollaboration(fixture(team()), { ...input, taskSize: 'complex',
    independentWork: { workKind: 'implementation', boundary: 'Only docs/ examples, no main implementation edits.', contextQueries: ['public examples'] } });
  const streams = result.divisionPlan.workstreams;
  assert.deepEqual(streams.map(s => s.id), ['main', 'independent', 'verification']);
  assert.deepEqual(streams.map(s => s.agentId), ['lead', 'developer', 'qa']);
  assert.deepEqual(streams[2].dependsOn, ['main', 'independent']);
  assert.equal(streams[1].boundary, 'Only docs/ examples, no main implementation edits.');
  assert.deepEqual(streams[1].dispatch.arguments.contextQueries, ['public examples']);
  assert.deepEqual(streams[1].dependsOn, []);
});

test('complexity alone never manufactures extra independent work', async () => {
  const result = await planAgentCollaboration(fixture(team()), { ...input, taskSize: 'complex' });
  assert.equal(result.divisionPlan.workstreams.length, 2);
});

test('verification excludes known implementers and opens existing HR flow on a real gap', async () => {
  const result = await planAgentCollaboration(fixture(team().slice(0, 2)), { ...input,
    implementationAgentIds: ['developer'] });
  const qa = result.divisionPlan.workstreams.at(-1);
  assert.equal(qa.agentId, null);
  assert.equal(qa.action, 'recruit');
  assert.equal(qa.dispatch.arguments.staffingIntent, 'new_durable');
  assert.equal(qa.dispatch.arguments.personalProjectId, 'sample');
  assert.equal(qa.dispatch.arguments.leadAgentId, undefined);
  assert.equal(qa.dispatch.askBeforeRecruitment, true);
});

test('a verification request never recursively recruits a verifier for its verifier', async () => {
  const result = await planAgentCollaboration(fixture(team()), { ...input,
    workKind: 'test_validation', implementationAgentIds: ['developer'] });
  assert.deepEqual(result.candidates.map(c => c.agentId), ['qa']);
  assert.equal(result.divisionPlan.workstreams.length, 1);
  assert.equal(result.divisionPlan.workstreams[0].agentId, 'qa');
});

test('cross-project verification waits for a scoped loan and unavailable clients cannot fill the role', async () => {
  const otherClient = agent('unavailable', ['test_validation']);
  otherClient.profile.allowed_clients = ['claude_code'];
  const result = await planAgentCollaboration(fixture([team()[0], otherClient,
    agent('source-lead', ['test_validation'], 'source'), agent('specialist', ['test_validation'], 'source')]), input);
  const qa = result.divisionPlan.workstreams.at(-1);
  assert.equal(qa.agentId, 'specialist');
  assert.equal(qa.action, 'request_loan');
  assert.equal(qa.borrow.approvalBy, 'source-lead');
  assert.equal(qa.dispatch.arguments.leadAgentId, 'specialist');
});

test('a qualified verifier on another client is an availability issue, not a recruitment gap', async () => {
  const qa = agent('qa', ['test_validation']);
  qa.profile.allowed_clients = ['claude_code'];
  const result = await planAgentCollaboration(fixture([agent('lead', ['implementation']), qa]), input);
  const stream = result.divisionPlan.workstreams.at(-1);
  assert.equal(stream.action, 'blocked');
  assert.equal(stream.dispatch, null);
  assert.equal(stream.blockedReason, 'qualified_agent_client_unavailable');
  assert.deepEqual(stream.unavailableCandidates.map(c => c.agentId), ['qa']);
  const standalone = await planAgentCollaboration(fixture([agent('lead', ['implementation']), qa]),
    { ...input, workKind: 'test_validation' });
  assert.equal(standalone.status, 'specialist_client_unavailable');
  assert.equal(standalone.recruitment, null);
});

test('delegated work runs in the first mode the host supports, in isolation order', async () => {
  const plan = async modes => (await planAgentCollaboration(fixture(team()), { ...input,
    ...(modes ? { hostExecutionModes: modes } : {}) })).divisionPlan.execution;
  assert.equal((await plan(['phased', 'sub_agent', 'new_session'])).mode, 'new_session');
  assert.equal((await plan(['phased', 'sub_agent'])).mode, 'sub_agent');
  const unknown = await plan();
  assert.equal(unknown.mode, null);
  assert.deepEqual(unknown.order, ['new_session', 'sub_agent', 'phased']);
  assert.equal((await plan([])).blockedReason, 'no_supported_execution_mode');
});

test('phased work writes each phase back to its own Agent memory', async () => {
  const execution = (await planAgentCollaboration(fixture(team()), { ...input,
    hostExecutionModes: ['phased'] })).divisionPlan.execution;
  assert.equal(execution.mode, 'phased');
  assert.deepEqual(execution.phases, [{ workstream: 'verification', agentId: 'developer',
    memoryIdempotencyKey: 'task:phase:verification' }]);
  assert.match(execution.guidance, /checkpoint_project_agent_memory/);
});

test('work kept in the current session needs no execution mode', async () => {
  const result = await planAgentCollaboration(fixture([team()[0]]), { ...input, taskSize: 'small',
    hostExecutionModes: ['new_session'] });
  assert.deepEqual(result.divisionPlan.execution, { mode: 'current_session' });
});

const withRole = (value, role) => ({ ...value, occupation: { role, tags: [] } });

test('the lead hands work to the requested occupation and keeps only coordination', async () => {
  const agents = [withRole(agent('lead', ['implementation']), 'management'),
    withRole(agent('designer', ['ui_design']), 'design'), withRole(agent('qa', ['test_validation']), 'testing')];
  const result = await planAgentCollaboration(fixture(agents), { ...input, occupation: 'design' });
  const [main, verification] = result.divisionPlan.workstreams;
  assert.equal(main.agentId, 'designer');
  assert.equal(main.action, 'delegate');
  assert.equal(result.divisionPlan.coordinatorAgentId, 'lead');
  assert.equal(verification.agentId, 'qa');
  assert.equal(result.candidates[0].occupation, 'design');
});

test('a matching occupation outranks work-kind matches and an unused occupation changes nothing', async () => {
  const agents = [withRole(agent('lead', ['implementation']), 'engineering'),
    withRole(agent('developer', ['implementation']), 'engineering'), withRole(agent('writer', ['implementation']), 'writing')];
  const writing = await planAgentCollaboration(fixture(agents), { ...input, occupation: 'writing' });
  assert.equal(writing.divisionPlan.workstreams[0].agentId, 'writer');
  const plain = await planAgentCollaboration(fixture(agents), input);
  assert.equal(plain.divisionPlan.workstreams[0].agentId, 'lead');
  assert.equal(plain.divisionPlan.workstreams[0].action, 'continue_current');
});
