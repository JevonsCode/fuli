import test from 'node:test';
import assert from 'node:assert/strict';
import { recordProjectMemoryUsage } from '../src/graphiti/project-memory-usage.js';
import { GraphitiProviderClient } from '../src/graphiti/provider-client.js';

test('empty results and same-project traffic do not record memory use', async () => {
  const writes = [];
  const app = { config: { personalSpaceId: 'space' },
    taskContextRegistry: { context: async () => ({ personalProjectId: 'source', sourceApplication: 'codex' }) },
    personal: { recordProjectMemoryUsage: async value => writes.push(value) } };
  await recordProjectMemoryUsage(app, { taskContextToken: 'token', targetProjectId: 'source', resultCount: 1 });
  await recordProjectMemoryUsage(app, { taskContextToken: 'token', targetProjectId: 'target', resultCount: 0 });
  assert.deepEqual(writes, []);
});

test('returned memory records only bounded provenance and the original task token', async () => {
  const writes = [];
  const app = { config: { personalSpaceId: 'space' },
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
