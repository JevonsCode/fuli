import assert from 'node:assert/strict';
import test from 'node:test';

import { callAgentTool } from '../src/agent-tools.js';
import { GraphitiProviderClient } from '../src/graphiti/provider-client.js';

test('MCP request cancellation reaches the active Provider request', async () => {
  const started = Promise.withResolvers();
  const client = new GraphitiProviderClient({
    baseUrl: 'http://127.0.0.1:9',
    accessToken: 'synthetic-access',
    requestTimeoutMs: 100,
    fetchImpl: async (_url, { signal }) => {
      started.resolve(signal);
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
  });
  const app = {
    getAgentAccessPolicy: () => ({ enabled: true }),
    getGraphitiStatus: () => client.health()
  };
  const controller = new AbortController();
  const cancelled = new Error('synthetic MCP request cancelled');
  const request = callAgentTool(
    app,
    'get_graphiti_status',
    {},
    { signal: controller.signal, requestId: 17 }
  );
  const providerSignal = await started.promise;
  controller.abort(cancelled);

  await assert.rejects(request, (error) => error === cancelled);
  assert.equal(providerSignal.aborted, true);
  assert.equal(providerSignal.reason, cancelled);
});

test('a direct Agent tool call fails before dispatch when already cancelled', async () => {
  let called = false;
  const app = {
    listKnowledgeSpaces: async () => {
      called = true;
      return [];
    }
  };
  const controller = new AbortController();
  const cancelled = new Error('synthetic direct-call cancellation');
  controller.abort(cancelled);

  await assert.rejects(
    async () => callAgentTool(
      app, 'list_knowledge_spaces', {}, { signal: controller.signal }
    ),
    (error) => error === cancelled
  );
  assert.equal(called, false);
});
