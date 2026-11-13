import test from 'node:test';
import assert from 'node:assert/strict';
import { createJudgmentService } from '../src/judgment/service.js';
import { createJudgmentEngine } from '../src/judgment/engine.js';
import { completePreferences } from './fixtures/collaboration-preferences.js';

test('routing respects locked executor, available models and scoped feedback; never claims dispatch', async t => {
  let prompt;
  const executor = id => ({ executorId: id, displayName: id, registrationStatus: 'registered', permissionStatus: 'authorized',
    preflightStatus: 'passed', workspacePermission: true, healthStatus: 'healthy',
    availableModels: [{ model: 'fixture-model', available: true, sourceApplication: 'codex' }] });
  const app = { config: { personal: { spaceId: 's' } }, listPersonalProjects: async () => [{ project_id: 'p' }],
    listProjectAgents: async () => [{ agentId: 'employee.tonborg', profile: { status: 'active', allowedClients: ['codex'], capabilities: ['fuli.employee:tonborg'] } }],
    getCollaborationPreferences: async () => completePreferences({ effective: [{ id: 'reliable', preference_key: 'reliable', preference_scope: 'global', confirmation_status: 'confirmed', instruction: 'Prefer reliable completion' }] }),
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

function routingFixture(t, { rules = [], executors, allowedClients = ['codex'], answer, strategy, judgeError = null } = {}) {
  let prompt;
  const app = { config: { personal: { spaceId: 's' } }, listPersonalProjects: async () => [{ project_id: 'p' }],
    listProjectAgents: async () => [{ agentId: 'employee.tonborg', profile: { status: 'active', allowedClients: ['codex'], capabilities: ['fuli.employee:tonborg'] } }],
    getCollaborationPreferences: async () => completePreferences(),
    inspectProjectAgentMemory: async () => ({ revision: 0 }),
    getProjectAgent: async () => ({ profile: { allowedClients, executorPolicy: { mode: 'flexible' }, defaultModelStrategy: strategy } }),
    listExecutors: async () => executors, listExecutorRoutingRules: async () => rules };
  const judge = async input => { prompt = input.prompt; if (judgeError) throw judgeError(); return { client: 'codex', body: JSON.stringify(answer ?? { executorId: 'space', model: 'model', disposition: 'delegate', conversationId: null, summary: 'Follow explicit scope rule', evidence: ['Space rule'] }) }; };
  const service = createJudgmentService({ app, engine: createJudgmentEngine({ app, judge }) });
  t.after(() => service.close());
  return { service, app, prompt: () => prompt };
}
const availableExecutor = (id, client = 'codex') => ({ executorId: id, displayName: id, executorKind: client,
  registrationStatus: 'registered', permissionStatus: 'authorized', preflightStatus: 'passed', workspacePermission: true,
  availableModels: [{ model: 'model', available: true }] });
const routingInput = { personalSpaceId: 's', personalProjectId: 'p', agentId: 'a', requestId: 'request', workKind: 'review', objective: 'Verify artifact' };

test('explicit max routing keeps only models that advertise max and preserves their exact IDs', async t => {
  const executor = availableExecutor('space');
  const exact = 'Synthetic.Provider/Exact-Model@2026';
  executor.availableModels = [
    { model: 'unknown-effort', available: true },
    { model: 'empty-effort', available: true, reasoningEfforts: [] },
    { model: 'high-only', available: true, reasoningEfforts: ['high'] },
    { model: exact, available: true, reasoningEfforts: ['default', 'low', 'medium', 'high', 'max'] }
  ];
  const { service, prompt } = routingFixture(t, { executors: [executor], strategy: { mode: 'deep', reasoningEffort: 'max' },
    answer: { executorId: 'space', model: exact, disposition: 'delegate', conversationId: null,
      summary: 'Explicit maximum effort is supported.', evidence: ['Observed max capability'] } });
  assert.equal((await service.assess(routingInput)).selection.model, exact);
  const eligible = JSON.parse(prompt().split('\nDATA:\n')[1]).eligible;
  assert.deepEqual(eligible[0].models.map(model => model.model), [exact]);
});

test('max without a declared matching capability never invokes a judge or downgrades to high', async t => {
  for (const reasoningEfforts of [undefined, [], ['high'], 'max']) {
    const executor = availableExecutor('space');
    executor.availableModels[0].reasoningEfforts = reasoningEfforts;
    const { service, prompt } = routingFixture(t, { executors: [executor], strategy: { mode: 'deep', reasoningEffort: 'max' } });
    const result = await service.assess(routingInput);
    assert.equal(result.selection, null);
    assert.equal(result.disposition, 'ask_user');
    assert.equal(prompt(), undefined);
  }
  for (const reasoningEffort of ['default', 'high']) {
    const { service } = routingFixture(t, { executors: [availableExecutor('space')], strategy: { mode: 'deep', reasoningEffort } });
    assert.equal((await service.assess(routingInput)).selection.model, 'model', 'legacy effort still accepts unknown capabilities');
  }
});
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
test('the judgment reads the last 30 days of client and model usage beside its evidence; its answer contract stays', async t => {
  const { service, app, prompt } = routingFixture(t, { executors: [availableExecutor('space')] });
  const windows = [];
  app.recallImpressions = { entriesByClientModel: async ({ personalSpaceId, from, to }) => {
    windows.push({ personalSpaceId, days: (Date.parse(to) - Date.parse(from)) / 86_400_000 });
    return [{ client: 'codex', model: 'synthetic-model', entries: 3 }, { client: 'claude-code', model: null, entries: 1 }];
  } };
  app.roundtable = { wakeUsage: async () => [{ client: 'claude_code', model: null, wakes: 2, failedWakes: 1,
    inputTokens: null, outputTokens: null, tokenWakes: 0 }] };
  const result = await service.assess(routingInput);
  assert.equal(result.selection.executorId, 'space');
  assert.deepEqual(windows, [{ personalSpaceId: 's', days: 30 }]);
  const data = JSON.parse(prompt().split('\nDATA:\n')[1]);
  assert.equal(data.recentUsage.days, 30);
  // How wakes ended rides along; a task entry records no outcome.
  assert.deepEqual(data.recentUsage.rows, [{ client: 'claude_code', model: null, taskEntries: 1, wakes: 2, failedWakes: 1 },
    { client: 'codex', model: 'synthetic-model', taskEntries: 3, wakes: 0, failedWakes: 0 }]);
  // A source that cannot be read leaves the input out; the judgment still answers.
  const quiet = routingFixture(t, { executors: [availableExecutor('space')] });
  quiet.app.recallImpressions = { entriesByClientModel: () => { throw new Error('synthetic store down'); } };
  assert.equal((await quiet.service.assess(routingInput)).selection.executorId, 'space');
  assert.equal('recentUsage' in JSON.parse(quiet.prompt().split('\nDATA:\n')[1]), false);
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

// rec#83: a failed judgment said only provider_error.
test('a failed executor judgment says where it stopped and what to do, without the error text', async t => {
  const { app, service } = routingFixture(t, { executors: [availableExecutor('space')] });
  const missing = Object.assign(new Error('secret provider words'), { code: 'provider_error', status: 404 });
  app.viewProjectAgentTask = async () => { throw missing; };
  const record = await service.assess({ ...routingInput, action: 'session', taskId: 'task-a', requestId: 'failed-read' });
  assert.equal(record.outcome, 'failed');
  assert.equal(record.error, 'provider_error');
  assert.deepEqual({ stage: record.failure.stage, category: record.failure.category, status: record.failure.status, retryable: record.failure.retryable },
    { stage: 'task', category: 'not_found', status: 404, retryable: false });
  assert.match(record.failure.recovery, /check the IDs/);
  assert.match(record.guidance, /no execution receipt/);
  assert.equal(JSON.stringify(record).includes('secret provider words'), false);
});

// rec#83: a global read naming an FLA crashed as internal_error.
test('a global read that names an FLA says what to do, and one without it reads', async t => {
  const { service } = routingFixture(t, { executors: [availableExecutor('space')] });
  await assert.rejects(service.agent.records({ personalSpaceId: 's', personalProjectId: null, projectAgentId: 'a', limit: 3 }),
    { code: 'invalid_input', message: /leave projectAgentId out/ });
  assert.ok(Array.isArray((await service.agent.records({ personalSpaceId: 's', personalProjectId: null, limit: 3 })).records));
});

// rec#10: a refused model call said retryable and "try again", against the refusal stop.
test('a refused or paused Tonborg model call says stop, not try again; a transient failure stays retryable', async t => {
  const failing = (status, failureClass, reason) => () => Object.assign(new Error('synthetic model words'), { code: reason,
    modelReceipt: { backend: 'model_api', status, reason, failureClass, requestedModel: 'synthetic-model', actualModel: null, attempts: 0, usage: null } });
  const cases = [['stopped', 'refusal', 'egress_not_approved', 'model_stopped', false], ['stopped', 'refusal', 'permission_denied', 'model_stopped', false],
    ['paused', 'budget_exhausted', 'per_call_input', 'model_paused', false], ['failed', 'transient', 'server_error', 'model', true]];
  for (const [status, failureClass, reason, category, retryable] of cases) {
    const { service } = routingFixture(t, { executors: [availableExecutor('space')], judgeError: failing(status, failureClass, reason) });
    const record = await service.assess({ ...routingInput, action: 'client', workKind: 'test_validation', requestId: reason });
    assert.equal(record.outcome, 'failed', reason);
    assert.deepEqual([record.error, record.failure.category, record.failure.retryable, record.selection], [reason, category, retryable, null], reason);
    assert.equal(record.modelReceipt.status, status, reason);
    assert.equal(Object.hasOwn(record, 'workPackage'), false, reason);
    assert.match(record.guidance, /no execution receipt. Do not make this judgment in its place/);
    if (retryable) assert.match(record.failure.recovery, /try again/);
    else assert.doesNotMatch(record.failure.recovery, /try again/i);
  }
});

// rec#110 item 7: a request Tonborg cannot use names its field; it never
// surfaces as a bare internal_error.
test('an unusable assess_agent_action request is invalid_input naming the field, not internal_error', async t => {
  const { errorToolResult } = await import('../src/mcp/tool-result.js');
  const { service } = routingFixture(t, { executors: [availableExecutor('space')] });
  const refused = async input => errorToolResult(await service.assess(input).then(() => assert.fail('accepted'), error => error));
  const global = await refused({ ...routingInput, personalProjectId: null });
  assert.equal(global.structuredContent.error.code, 'invalid_input');
  assert.match(global.structuredContent.error.message, /personalProjectId/);
  await service.assess(routingInput);
  const reused = await refused({ ...routingInput, objective: 'Different synthetic objective' });
  assert.equal(reused.structuredContent.error.code, 'invalid_input');
  assert.match(reused.structuredContent.error.message, /pass a new requestId/);
});

test('an unknown request field is named only as unknown field; its caller-chosen key is never echoed', async t => {
  const { errorToolResult } = await import('../src/mcp/tool-result.js');
  const { service } = routingFixture(t, { executors: [availableExecutor('space')] });
  const key = 'sk-synthetic-0123456789abcdef/C:\synthetic\path';
  const error = await service.assess({ ...routingInput, [key]: 'x' }).then(() => assert.fail('accepted'), value => value);
  const { structuredContent, content } = errorToolResult(error);
  assert.equal(structuredContent.error.code, 'invalid_input');
  assert.match(structuredContent.error.message, /request: unknown field/);
  assert.equal(JSON.stringify({ structuredContent, content }).includes('sk-synthetic'), false);
});
