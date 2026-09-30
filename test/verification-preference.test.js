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
