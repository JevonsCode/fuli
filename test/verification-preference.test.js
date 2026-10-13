import test from 'node:test';
import assert from 'node:assert/strict';
import { verificationPreference } from '../src/graphiti/verification-preference.js';
const executor = (executorId, priority) => ({ executorId, globalPriority: priority, registrationStatus:'registered',
  permissionStatus:'authorized', preflightStatus:'passed', workspacePermission:true, availableModels:[{ available:true }] });
test('15-second default only includes authorized available executors and stays task-local', () => {
  const result=verificationPreference({ now:0, projectId:'sample', executors:[executor('one',2),executor('two',1),{ ...executor('blocked',0),permissionStatus:'pending' }] });
  assert.equal(result.expiresAt,'1970-01-01T00:00:15.000Z');
  assert.equal(result.recommendedExecutorId,'two'); assert.equal(result.scope,'task'); assert.equal(result.shouldAsk,true);
});
test('project preference wins global; locks never expand', () => {
  const base={projectId:'sample',executors:[executor('one',1),executor('two',2)],rules:[
    {scope:'global',status:'active',workKind:'test_validation',executorIds:['one']},
    {scope:'project',personalProjectId:'sample',status:'active',workKind:'test_validation',executorIds:['two']}]};
  assert.equal(verificationPreference(base).recommendedExecutorId,'two');
  assert.equal(verificationPreference({...base,lockedExecutorIds:['one']}).recommendedExecutorId,'one');
  assert.equal(verificationPreference({...base,lockedExecutorIds:[]}).status,'blocked');
  assert.equal(verificationPreference({...base,rules:base.rules.map(rule=>({...rule,status:'disabled'}))}).choiceSource,'task_default');
});
test('an unhealthy executor is unavailable even without a required health probe', () => {
  const result = verificationPreference({ projectId:'sample', executors:[
    {...executor('broken',0), healthRequired:false, healthStatus:'unhealthy'}, executor('ready',1)
  ] });
  assert.equal(result.recommendedExecutorId, 'ready');
  assert.equal(result.shouldAsk, false);
});

test('collaboration planning applies the Agent profile executor lock', async () => {
  const { planAgentCollaboration } = await import('../src/graphiti/agent-collaboration.js');
  const application = { config: { personal:{spaceId:'space'} },
    taskContextRegistry:{context:async()=>({projectAgentId:'engineer',personalProjectId:'sample'})},
    personal:{listProjectAgents:async()=>[],getProjectAgentCoordinationPolicy:async()=>({}),agentLoan:async()=>({loans:[]})},
    listExecutors:async()=>[executor('outside',0),executor('inside',1)], listExecutorRoutingRules:async()=>[],
    getProjectAgent:async()=>({profile:{executorPolicy:{mode:'locked',lockedExecutorIds:['inside']}}}) };
  const result = await planAgentCollaboration(application,{taskContextToken:'current',sourceApplication:'codex',workKind:'test_validation'});
  assert.equal(result.preferencePrompt.recommendedExecutorId,'inside');
  assert.equal(result.preferencePrompt.shouldAsk,false);
});

function collaborationFixture(agents, policies = {}) {
  return { config: { personal: { spaceId: 'space' } },
    taskContextRegistry: { context: async (token, client) => {
      assert.equal(token, 'current'); assert.equal(client, 'codex');
      return { projectAgentId: 'target-lead', personalProjectId: 'target' };
    } },
    personal: { listProjectAgents: async () => agents, agentLoan: async () => ({ loans: [] }),
      getProjectAgentCoordinationPolicy: async (_space, project) => policies[project] ?? {} },
    listExecutors: async () => [], listExecutorRoutingRules: async () => [],
    getProjectAgent: async () => ({ profile: {} }) };
}
const roleAgent = (agentId, assignments, profile = {}) => ({ agent_id: agentId,
  profile: { name: agentId, allowed_clients: ['codex'], capabilities: [], work_kinds: [], ...profile },
  assignments: assignments.map(item => ({ status: 'active', capabilities: [], work_kinds: [], ...item })) });

test('collaboration discovery uses effective assignment capabilities and excludes ineligible specialists', async () => {
  const { planAgentCollaboration } = await import('../src/graphiti/agent-collaboration.js');
  const agents = [
    // A nonempty assignment list overrides the profile; it is not a union.
    roleAgent('overridden', [{ personal_project_id: 'source', capabilities: ['design'] }], { capabilities: ['test execution'] }),
    roleAgent('inherits', [{ personal_project_id: 'source', capabilities: [], responsibility: 'Public QA duty' }],
      { capabilities: ['test execution'], private_notes: 'never expose' }),
    roleAgent('claude-only', [{ personal_project_id: 'source', capabilities: ['test execution'] }], { allowed_clients: ['claude_code'] }),
    roleAgent('inactive', [{ personal_project_id: 'source', capabilities: ['test execution'], status: 'ended' }]),
    roleAgent('source-lead', [{ personal_project_id: 'source', capabilities: ['test execution'] }]),
    // A management peer matches only its own declared work, like Provider staffing.
    roleAgent('employee.bole', [{ personal_project_id: 'target', capabilities: ['fuli.employee:bole'], work_kinds: ['recruitment'] }],
      { agent_type: 'hr' }),
    roleAgent('local', [{ personal_project_id: 'target', capabilities: ['test execution'] }])
  ];
  const result = await planAgentCollaboration(collaborationFixture(agents, { target: { team_lead_agent_id: 'target-lead' },
    source: { team_lead_agent_id: 'source-lead' } }), { taskContextToken: 'current', sourceApplication: 'codex',
    workKind: 'verification', requiredCapabilities: ['Test Execution'] });
  assert.deepEqual(result.candidates.map(item => [item.agentId, item.projectId, item.requiresLoan]),
    [['local', 'target', false], ['inherits', 'source', true]]);
  const borrowed = result.candidates[1];
  assert.deepEqual(borrowed.capabilities, ['test execution']);
  assert.equal(borrowed.responsibility, 'Public QA duty');
  assert.equal(borrowed.sourceLeadId, 'source-lead');
  assert.equal(JSON.stringify(result).includes('never expose'), false);
  assert.equal(result.executionStarted, false);
  assert.equal(result.status, 'specialists_available');
  // Next steps: roundtable for advice, a lead-to-lead loan for execution.
  assert.equal(borrowed.nextSteps.ask.tool, 'message_agent');
  assert.equal(borrowed.nextSteps.ask.advisoryOnly, true);
  assert.equal(borrowed.nextSteps.borrow.tool, 'request_agent_loan');
  assert.deepEqual(borrowed.nextSteps.borrow.arguments, { sourceProjectId: 'source', specialistId: 'inherits' });
  assert.deepEqual(borrowed.nextSteps.borrow.requires, ['targetTaskId', 'objective', 'idempotencyKey']);
  assert.equal(borrowed.nextSteps.borrow.approvalBy, 'source-lead');
  assert.equal(result.candidates[0].nextSteps.borrow, undefined, 'a local assignment needs no loan');
  assert.equal(result.candidates[0].nextSteps.execute.tool, 'coordinate_project_agent_task');
  assert.equal(result.recruitment, null);
});

test('collaboration discovery without a qualified specialist routes to existing HR recruitment', async () => {
  const { planAgentCollaboration } = await import('../src/graphiti/agent-collaboration.js');
  const result = await planAgentCollaboration(collaborationFixture([
    roleAgent('designer', [{ personal_project_id: 'source', capabilities: ['design'] }])
  ], { target: { team_lead_agent_id: 'target-lead', ask_before_recruitment: true } }), { taskContextToken: 'current',
    sourceApplication: 'codex', workKind: 'verification', requiredCapabilities: ['test execution'] });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.status, 'no_qualified_specialist');
  assert.equal(result.executionStarted, false);
  const hr = result.recruitment;
  assert.equal(hr.tool, 'coordinate_project_agent_task');
  assert.deepEqual(hr.arguments, { taskContextToken: 'current', personalProjectId: 'target', workKind: 'verification',
    requiredCapabilities: ['test execution'], staffingIntent: 'new_durable' });
  assert.deepEqual(hr.requires, ['idempotencyKey', 'title', 'objective', 'routingReason', 'contextQueries']);
  assert.equal(hr.coordinatorAgentId, 'target-lead');
  assert.equal(hr.askBeforeRecruitment, true);
  assert.match(hr.guidance, /idempotencyKey/);
});
