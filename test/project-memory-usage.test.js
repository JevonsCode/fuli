import test from 'node:test';
import assert from 'node:assert/strict';
import { recordProjectMemoryUsage } from '../src/graphiti/project-memory-usage.js';
import { GraphitiProviderClient } from '../src/graphiti/provider-client.js';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';

test('empty results and same-project traffic do not record memory use', async () => {
  const writes = [];
  const app = { config: { personal: { spaceId: 'space' } },
    taskContextRegistry: { context: async () => ({ personalProjectId: 'source', sourceApplication: 'codex' }) },
    personal: { recordProjectMemoryUsage: async value => writes.push(value) } };
  await recordProjectMemoryUsage(app, { taskContextToken: 'token', targetProjectId: 'source', resultCount: 1 });
  await recordProjectMemoryUsage(app, { taskContextToken: 'token', targetProjectId: 'target', resultCount: 0 });
  assert.deepEqual(writes, []);
});

test('returned memory records only bounded provenance and the original task token', async () => {
  const writes = [];
  const app = { config: { personal: { spaceId: 'space' } },
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
