import test from 'node:test';
import assert from 'node:assert/strict';
import { recordProjectMemoryUsage, recordReadExtensionUsage } from '../src/graphiti/project-memory-usage.js';
import { GraphitiProviderClient } from '../src/graphiti/provider-client.js';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';

test('empty results and same-project traffic do not record memory use', async () => {
  const writes = [];
  const app = { config: { personal: { spaceId: 'space' } }, getCapturePolicy: () => ({ enabled: true }),
    taskContextRegistry: { context: async () => ({ personalProjectId: 'source', sourceApplication: 'codex' }) },
    personal: { recordProjectMemoryUsage: async value => writes.push(value) } };
  await recordProjectMemoryUsage(app, { taskContextToken: 'token', targetProjectId: 'source', resultCount: 1 });
  await recordProjectMemoryUsage(app, { taskContextToken: 'token', targetProjectId: 'target', resultCount: 0 });
  assert.deepEqual(writes, []);
});

test('returned memory records only bounded provenance and the original task token', async () => {
  const writes = [];
  const app = { config: { personal: { spaceId: 'space' } }, getCapturePolicy: () => ({ enabled: true }),
    taskContextRegistry: { context: async () => ({ personalProjectId: 'source', sourceApplication: 'codex' }) },
    personal: { recordProjectMemoryUsage: async value => { writes.push(value); return { recorded: true }; } } };
  const result = await recordProjectMemoryUsage(app, { taskContextToken: 'token',
    targetProjectId: 'target', channel: 'roundtable_answer', evidenceId: 'answer', resultCount: 1,
    body: 'must never be stored' });
  assert.equal(result.recorded, true);
  assert.deepEqual(writes, [{ personal_space_id: 'space', task_context_token: 'token',
    source_application: 'codex', target_project_id: 'target', channel: 'roundtable_answer',
    evidence_id: 'answer', result_count: 1 }]);
});

test('memory usage keeps the source application when reading the actual task context', async () => {
  const app = { config: { personal: { spaceId: 'space' } }, getCapturePolicy: () => ({ enabled: true }),
    taskContextRegistry: { context: async (token, source) => {
      assert.equal(source, 'codex');
      return { personalProjectId: 'source', sourceApplication: source };
    } }, personal: { recordProjectMemoryUsage: async () => ({ recorded: true }) } };
  assert.equal((await recordProjectMemoryUsage(app, { taskContextToken: 'token', sourceApplication: 'codex',
    targetProjectId: 'target', channel: 'roundtable_answer', evidenceId: 'answer', resultCount: 1 })).recorded, true);
});

test('one read-only expansion records only returned project hits against its verified current task', async () => {
  const writes = [];
  const task = { token: 'live-task', personalProjectId: 'source', sourceApplication: 'codex' };
  const app = { config: { personal: { spaceId: 'space' } }, getCapturePolicy: () => ({ enabled: true }), taskContextRegistry: {
    current: async (session, source) => { assert.equal(session, 'native-session'); assert.equal(source, 'codex'); return task; },
    context: async () => task }, personal: { recordProjectMemoryUsage: async value => { writes.push(value); return { recorded: true }; } } };
  const input = { sourceSessionId: 'native-session', sourceApplication: 'codex', personalProjectScope: 'all_local_confirmed',
    personalProjectId: 'source', facts: [{ id: 'one', scope: 'personal', defined_project_id: 'target' },
      { id: 'two', scope: 'personal', defined_project_id: 'source' }, { id: 'global', scope: 'personal', defined_project_id: null }],
    entities: [] };
  await recordReadExtensionUsage(app, input);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].target_project_id, 'target');
  assert.equal(writes[0].channel, 'read_extension_result');
  assert.equal(writes[0].task_context_token, 'live-task');
  writes.length = 0;
  await recordReadExtensionUsage(app, { ...input, personalProjectScope: 'bounded' });
  await recordReadExtensionUsage(app, { ...input, sourceSessionId: 'fuli-host-unknown' });
  await recordReadExtensionUsage(app, { ...input, facts: [] });
  assert.equal(writes.length, 0);
});

test('Provider observation port uses authenticated POST and propagates stale-context failure', async () => {
  const calls = [];
  const client = new GraphitiProviderClient({ baseUrl: 'http://127.0.0.1:1234', accessToken: 'synthetic-token',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ detail: 'Task context is superseded' }),
        { status: 409, headers: { 'content-type': 'application/json' } });
    } });
  await assert.rejects(client.recordProjectMemoryUsage({ task_context_token: 'synthetic-task' }), { status: 409 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:1234/v1/project-memory-usage');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(JSON.parse(calls[0].options.body).task_context_token, 'synthetic-task');
});

test('real application configuration reaches the Provider observation endpoint', async () => {
  let observed;
  const app = new FederatedGraphApplication({ version: 1, personal: {
    providerUrl: 'http://127.0.0.1:1234', accessToken: 'synthetic-token',
    principalId: 'synthetic-user', spaceId: 'actual-config-space'
  }, workspaces: [] }, { fetchImpl: async (url, options) => {
    observed = { url, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ recorded: true }), { headers: { 'content-type': 'application/json' } });
  } });
  app.taskContextRegistry = { context: async () => ({ personalProjectId: 'source', sourceApplication: 'codex' }) };
  const result = await recordProjectMemoryUsage(app, { taskContextToken: 'token', targetProjectId: 'target',
    channel: 'roundtable_answer', evidenceId: 'answer', resultCount: 1 });
  assert.equal(result.recorded, true);
  assert.equal(observed.body.personal_space_id, 'actual-config-space');
  assert.equal(observed.url, 'http://127.0.0.1:1234/v1/project-memory-usage');
});

test('the search application records an expanded hit through the actual Provider port', async () => {
  const observed = [];
  const app = new FederatedGraphApplication({ version: 1, personal: {
    providerUrl: 'http://127.0.0.1:1234', accessToken: 'synthetic-token',
    principalId: 'synthetic-user', spaceId: 'space'
  }, workspaces: [] }, { fetchImpl: async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:1234/v1/project-memory-usage');
    observed.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ recorded: true }), { headers: { 'content-type': 'application/json' } });
  } });
  const task = { token: 'live-task', personalProjectId: 'source', sourceApplication: 'codex' };
  app.taskContextRegistry = { current: async () => task, context: async () => task };
  Object.assign(app.personal, {
    listPersonalProjects: async () => [{ project_id: 'source' }, { project_id: 'target' }],
    search: async () => ({ facts: [{ id: 'synthetic-fact', fact: 'Synthetic target knowledge',
      defined_project_id: 'target', score: 1 }], entities: [] }),
    graph: async () => ({ nodes: [], edges: [] }), recordAgentViews: async () => ({})
  });
  const result = await app.searchKnowledge({ personalSpaceId: 'space', personalProjectScope: 'all_local_confirmed',
    query: 'Synthetic target knowledge', sourceApplication: 'codex', sourceSessionId: 'native-session', agentInvocation: true });
  assert.equal(result.facts.length, 1);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].task_context_token, 'live-task');
  assert.equal(observed[0].target_project_id, 'target');
  assert.equal(observed[0].channel, 'read_extension_result');
  await app.close();
});
