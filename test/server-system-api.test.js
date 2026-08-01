import assert from 'node:assert/strict';
import test from 'node:test';

import { createServer } from '../src/server.js';
import { closeServer, getJson, requestJson } from '../test-support/server.js';

test('system API exposes resource samples and validates persisted settings through one service', async () => {
  const updates = [];
  const configured = {
    version: 1,
    ports: {
      console: 2727,
      personalProvider: 8787,
      personalNeo4jHttp: 8060,
      personalNeo4jBolt: 7687,
      workspaceProvider: 8788,
      workspaceNeo4jHttp: 7475,
      workspaceNeo4jBolt: 7688
    },
    lanAccess: false,
    resourceRefreshSeconds: 5
  };
  const system = {
    getSettings: () => ({ configured, active: configured, restartRequired: false }),
    updateSettings: (input) => {
      updates.push(input);
      return { configured: input, active: configured, restartRequired: true };
    },
    resources: async () => ({
      sampledAt: '2026-08-01T10:00:00.000Z',
      status: 'ready',
      memory: { usedBytes: 42 },
      disk: { usedBytes: 84 }
    })
  };
  const app = { graphiti: true, close() {} };
  const { server, url } = await createServer({ app, system, port: 0 });
  try {
    assert.equal((await getJson(`${url}/api/system/settings`)).configured.ports.console, 2727);
    assert.equal((await getJson(`${url}/api/system/resources`)).memory.usedBytes, 42);
    const next = { ...configured, ports: { ...configured.ports, console: 3030 } };
    const response = await requestJson(`${url}/api/system/settings`, {
      method: 'PUT',
      body: next
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.restartRequired, true);
    assert.deepEqual(updates, [next]);
  } finally {
    await closeServer(server);
  }
});
