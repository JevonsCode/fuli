import assert from 'node:assert/strict';
import test from 'node:test';
import { handleGraphApiRequest } from '../src/http/graph-api-router.js';
import { GraphitiProviderClient } from '../src/graphiti/provider-client.js';
import { ProjectAgentControlPlaneApplication, projectAgentControlPlaneHooks } from '../src/graphiti/project-agent-control-plane.js';

test('Task run history uses a bounded dedicated read without expanding default task payloads', async () => {
  const calls = [];
  const provider = new GraphitiProviderClient({ baseUrl: 'http://synthetic.invalid', accessToken: 'synthetic-only',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ runs: [{ run_id: 'run-1', task_id: 'task/1', state: 'closed',
        execution_status: 'failed', attempt_number: 1, root_run_id: 'run-1',
        execution_result: { failure_class: 'network', prompt_dispatched: false, retry_eligible: true } }],
        next_cursor: null, complete: true }), { headers: { 'content-type': 'application/json' } });
    } });
  class App extends ProjectAgentControlPlaneApplication {
    personal = provider;
    [projectAgentControlPlaneHooks.assertActivePersonalSpace](space) { assert.equal(space, 'space'); }
  }
  const app = new App();
  let body;
  const response = { writeHead(status) { assert.equal(status, 200); }, end(value) { body = JSON.parse(value); } };
  const handled = await handleGraphApiRequest({ request: { method: 'GET' }, response,
    url: new URL('http://localhost/api/project-agent-tasks/task%2F1/runs?personalSpaceId=space&personalProjectId=project&limit=1&cursor=run-0'), app });
  assert.equal(handled, true);
  assert.equal(body.runs[0].runId, 'run-1');
  assert.equal(body.runs[0].executionStatus, 'failed');
  assert.equal(body.runs[0].executionResult.failureClass, 'network');
  assert.equal(body.runs[0].actualModel, null);
  assert.equal(body.complete, true);
  const target = new URL(calls[0].url);
  assert.equal(target.pathname, '/v1/project-agent-tasks/task%2F1/runs');
  assert.equal(target.searchParams.get('limit'), '1');
  assert.equal(target.searchParams.get('cursor'), 'run-0');
});
