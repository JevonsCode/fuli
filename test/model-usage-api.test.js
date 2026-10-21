import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { callAgentTool, listAgentTools } from '../src/agent-tools.js';
import { mapHttpError } from '../src/http/error-mapping.js';
import { handleModelBackendApiRequest } from '../src/model-backends/http.js';
import { createModelBackendPort } from '../src/model-backends/port.js';
import { readModelBackendConfig } from '../src/model-backends/config.js';
import { ModelUsageLedger } from '../src/model-backends/usage-ledger.js';
import { listenFetchableServer } from '../src/server/listen.js';

const NOW = new Date('2026-10-20T12:00:00.000Z');

function port() {
  const ledger = new ModelUsageLedger(':memory:');
  ledger.record({
    requestId: 'req-1', attemptId: 'a1', attemptNumber: 1, purpose: 'initial', channel: 'model_api',
    role: 'bole', operation: 'pick', personalSpaceId: 'space', personalProjectId: 'alpha', connectionId: 'local',
    protocol: 'openai_chat', endpointHost: '127.0.0.1:11434', requestedModel: 'qwen', actualModel: 'qwen:4b',
    outputMode: 'json_schema', startedAt: '2026-10-20T10:00:00.000Z', durationMs: 120, outcome: 'succeeded',
    failureClass: null, failureReason: null,
    usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60, cachedInputTokens: null, cacheWriteInputTokens: null,
      reasoningTokens: null, definition: 'openai_chat' },
    budgetCeilingTokens: 1000, estimatedCost: null, costCurrency: null
  });
  const config = { version: 1,
    connections: { local: { protocol: 'openai_chat', endpoint: 'http://127.0.0.1:11434/v1', model: 'qwen', secretRef: null } },
    roles: { bole: { enabled: true, connection: 'local', allowedOperations: ['pick'],
      budget: { maxInputTokens: 4000, maxOutputTokens: 400, timeoutMs: 30_000, windowHours: 24, maxTokensPerWindow: 100_000 } } } };
  return createModelBackendPort({ readConfig: () => readModelBackendConfig('x', { read: () => config }),
    secrets: { read: async () => null }, ledger, fetchImpl: async () => { throw new Error('no model call'); }, now: () => NOW });
}

test('the Agent tool reads compact usage with budgets and never a prompt or key', async () => {
  const definition = listAgentTools().find(tool => tool.name === 'get_model_usage');
  assert.ok(definition);
  assert.deepEqual(Object.keys(definition.inputSchema.properties).sort(), ['from', 'role', 'to']);
  const result = await callAgentTool({ modelBackends: port() }, 'get_model_usage', { role: 'bole' });
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].requests, 1);
  assert.deepEqual(result.budgets, [{ role: 'bole', windowHours: 24, maxTokens: 100_000, usedTokens: 60, reservedTokens: 0,
    maxCost: null, estimatedCost: null, cost: 'unknown' }]);
  assert.match(result.notes, /never added/);
  await assert.rejects(Promise.resolve().then(() => callAgentTool({ modelBackends: port() }, 'get_model_usage', { role: 'nobody' })), TypeError);
});

test('the console reads the same usage over HTTP', async () => {
  const app = { modelBackends: port() };
  const server = createServer(async (request, response) => {
    try {
      if (!await handleModelBackendApiRequest({ request, response, url: new URL(request.url, 'http://local'),
        modelBackends: app.modelBackends })) response.writeHead(404).end();
    } catch (error) {
      const mapped = mapHttpError(error);
      response.writeHead(mapped.status, { 'content-type': 'application/json' }).end(JSON.stringify(mapped.body));
    }
  });
  await listenFetchableServer(server, 0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await fetch(`${base}/api/model-backends/usage?role=bole&from=2026-10-20T00:00:00.000Z`);
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.deepEqual(body.groups[0].actualModels, ['qwen:4b']);
    assert.equal(body.range.from, '2026-10-20T00:00:00.000Z');
    const empty = await (await fetch(`${base}/api/model-backends/usage?to=2026-10-01T00:00:00.000Z`)).json();
    assert.deepEqual(empty.groups, []);
    assert.equal((await fetch(`${base}/api/model-backends/usage?from=yesterday`)).status, 400);
    assert.equal((await fetch(`${base}/api/model-backends/usage`, { method: 'POST' })).status, 405);
  } finally { server.close(); }
});
