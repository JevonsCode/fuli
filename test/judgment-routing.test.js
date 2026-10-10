import test from 'node:test';
import assert from 'node:assert/strict';
import { createJudgmentService } from '../src/judgment/service.js';
import { createJudgmentEngine } from '../src/judgment/engine.js';

test('routing respects locked executor, available models and scoped feedback; never claims dispatch', async t => {
  let prompt;
  const executor = id => ({ executorId: id, displayName: id, registrationStatus: 'registered', permissionStatus: 'authorized',
    preflightStatus: 'passed', workspacePermission: true, healthStatus: 'healthy',
    availableModels: [{ model: 'fixture-model', available: true, sourceApplication: 'codex' }] });
  const app = { config: { personal: { spaceId: 's' } }, listPersonalProjects: async () => [{ project_id: 'p' }],
    listProjectAgents: async () => [{ agentId: 'employee.tonborg', profile: { status: 'active', allowedClients: ['codex'], capabilities: ['fuli.employee:tonborg'] } }],
    getCollaborationPreferences: async () => ({ effective_preferences: [{ instruction: 'Prefer reliable completion' }] }),
    inspectProjectAgentMemory: async () => ({ revision: 2, current: { memory: { summary: 'Use relevant verification' } } }),
    getProjectAgent: async () => ({ profile: { allowedClients: ['codex'], executorPolicy: { mode: 'locked', lockedExecutorIds: ['allowed'] } } }),
    listExecutors: async () => [executor('allowed'), executor('forbidden')], listExecutorRoutingRules: async () => [] };
  const judge = async input => { prompt = input.prompt; return { body: JSON.stringify({ executorId: 'allowed', model: 'fixture-model', disposition: 'delegate', conversationId: null, summary: 'Only eligible executor', evidence: ['Passed preflight'] }), client: 'codex' }; };
  const service = createJudgmentService({ app, engine: createJudgmentEngine({ app, judge }) });
  t.after(() => service.close());
  const result = await service.assess({ personalSpaceId: 's', personalProjectId: 'p', agentId: 'a', requestId: 'routing-request', workKind: 'review', objective: 'Verify synthetic artifact', action: 'subagent' });
  assert.equal(result.selection.executorId, 'allowed');
  assert.equal(result.selection.client, 'codex');
  assert.equal(result.execution.status, 'not_applied');
  assert.doesNotMatch(prompt, /forbidden/);
  assert.match(prompt, /Use relevant verification/);
});

function routingFixture(t, { rules = [], executors, allowedClients = ['codex'], answer } = {}) {
  let prompt;
  const app = { config: { personal: { spaceId: 's' } }, listPersonalProjects: async () => [{ project_id: 'p' }],
    listProjectAgents: async () => [{ agentId: 'employee.tonborg', profile: { status: 'active', allowedClients: ['codex'], capabilities: ['fuli.employee:tonborg'] } }],
    getCollaborationPreferences: async () => ({ effective_preferences: [] }),
    inspectProjectAgentMemory: async () => ({ revision: 0 }),
    getProjectAgent: async () => ({ profile: { allowedClients, executorPolicy: { mode: 'flexible' } } }),
    listExecutors: async () => executors, listExecutorRoutingRules: async () => rules };
  const judge = async input => { prompt = input.prompt; return { client: 'codex', body: JSON.stringify(answer ?? { executorId: 'space', model: 'model', disposition: 'delegate', conversationId: null, summary: 'Follow explicit scope rule', evidence: ['Space rule'] }) }; };
  const service = createJudgmentService({ app, engine: createJudgmentEngine({ app, judge }) });
  t.after(() => service.close());
  return { service, app, prompt: () => prompt };
}
const availableExecutor = (id, client = 'codex') => ({ executorId: id, displayName: id, executorKind: client,
  registrationStatus: 'registered', permissionStatus: 'authorized', preflightStatus: 'passed', workspacePermission: true,
  availableModels: [{ model: 'model', available: true }] });
const routingInput = { personalSpaceId: 's', personalProjectId: 'p', agentId: 'a', requestId: 'request', workKind: 'review', objective: 'Verify artifact' };
test('inferred executor clients obey the Agent allowedClients boundary', async t => {
  const { service, prompt } = routingFixture(t, { executors: [availableExecutor('forbidden', 'claude_code')] });
  assert.equal((await service.assess(routingInput)).selection, null);
  assert.equal(prompt(), undefined);
});
test('task and assignment locks intersect and the task model strategy constrains the selection', async t => {
  const keep = availableExecutor('space');
  keep.capabilities = ['verification'];
  keep.availableModels = [
    { model: 'model', available: true, strategyModes: ['deep'], reasoningEfforts: ['high'], capabilities: ['reasoning'] },
    { model: 'fast', available: true, strategyModes: ['fast'], reasoningEfforts: ['low'] }
  ];
  const { service, app, prompt } = routingFixture(t, { executors: [keep, availableExecutor('other')] });
  app.getProjectAgent = async () => ({ profile: { allowedClients: ['codex'], executorPolicy: { mode: 'flexible' } },
    assignments: [{ personalProjectId: 'p', status: 'active', executorPolicyOverride: { mode: 'locked', lockedExecutorIds: ['space', 'other'] } }] });
  app.viewProjectAgentTask = async () => ({ personalProjectId: 'p', executorPolicy: { mode: 'locked', lockedExecutorIds: ['space'] },
    effectiveModelStrategy: { mode: 'deep', reasoningEffort: 'high', capabilityHints: ['reasoning'] }, requiredCapabilities: ['verification'] });
  assert.equal((await service.assess({ ...routingInput, taskId: 'task' })).selection.executorId, 'space');
  const data = JSON.parse(prompt().split('\nDATA:\n')[1]);
  assert.deepEqual(data.eligible.map(e => e.executorId), ['space']);
  assert.deepEqual(data.eligible[0].models.map(m => m.model), ['model']);
});
test('judgment client cannot read another Agent history through a different eligible client', async t => {
  const { service, app } = routingFixture(t, { executors: [availableExecutor('space', 'claude_code')], allowedClients: ['claude_code'] });
  app.queryAgentConversations = async () => assert.fail('Codex must not read Claude-only Agent conversations');
  assert.equal((await service.assess(routingInput)).selection.client, 'claude_code');
});
test('routing rule scope outranks numeric priority and task rules apply only to that task', async t => {
  const rules = [
    { scope: 'global', status: 'active', workKind: 'review', executorIds: ['global'], priority: 1 },
    { scope: 'space', personalSpaceId: 's', status: 'active', workKind: 'review', executorIds: ['space'], priority: 100 },
    { scope: 'task', personalProjectId: 'p', taskId: 'other-task', status: 'active', workKind: 'review', executorIds: ['global'], priority: 1 }
  ];
  const { service, prompt } = routingFixture(t, { executors: [availableExecutor('global'), availableExecutor('space')], rules });
  assert.equal((await service.assess(routingInput)).selection.executorId, 'space');
  assert.doesNotMatch(prompt().split('\nDATA:\n')[1], /"executorId":"global"/);
});
test('session reuse accepts only scoped conversation IDs and preserves choice context in feedback', async t => {
  const { service, app, prompt } = routingFixture(t, { executors: [availableExecutor('space')],
    answer: { executorId: 'space', model: 'model', disposition: 'reuse_conversation', conversationId: 'conversation-a', summary: 'Continue relevant work', evidence: ['Existing scoped summary'] } });
  app.queryAgentConversations = async scope => { assert.equal(scope.agentId, 'a'); assert.equal(scope.personalProjectId, 'p');
    return { conversations: [{ id: 'conversation-a', summary: 'Earlier verification', revision: 3 }] }; };
  const first = await service.assess({ ...routingInput, action: 'session' });
  assert.equal(first.disposition, 'reuse_conversation');
  service.feedback({ personalSpaceId: 's', decisionId: first.id, vote: 'down', reason: '', expectedRevision: 0 });
  await service.assess({ ...routingInput, action: 'session', requestId: 'next' });
  const data = JSON.parse(prompt().split('\nDATA:\n')[1]);
  assert.equal(data.feedback[0].selection.model, 'model');
  assert.equal(data.feedback[0].workKind, 'review');
  app.queryAgentConversations = async () => ({ conversations: [] });
  assert.equal((await service.assess({ ...routingInput, action: 'session', requestId: 'missing' })).outcome, 'failed');
});
