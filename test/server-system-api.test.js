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

test('system API exposes runtime leases and brackets graph requests without waking status polls',
  async () => {
    const events = [];
    const leaseId = '11111111-1111-4111-8111-111111111111';
    const system = {
      getSettings: () => ({}),
      updateSettings: () => ({}),
      resources: async () => ({}),
      runtimeStatus: () => ({ enabled: true, stage: 'sleeping', activeLeaseCount: 0 }),
      acquireRuntimeLease: async (input) => {
        events.push(['acquire', input]);
        return { enabled: true, leaseId };
      },
      refreshRuntimeLease: (id) => ({ refreshed: id === leaseId }),
      releaseRuntimeLease: (id) => ({ released: id === leaseId }),
      async withGraphRuntimeLease(owner, operation) {
        events.push(['enter', owner]);
        try { return await operation(); } finally { events.push(['leave', owner]); }
      }
    };
    const app = { state: async () => ({ ready: true }), close() {} };
    const externalKnowledge = {
      listBindings: async () => [],
      syncBinding: async (id) => ({ bindingId: id, status: 'synced' })
    };
    const { server, url } = await createServer({
      app, system, externalKnowledge, port: 0
    });
    try {
      assert.equal((await getJson(`${url}/api/system/runtime`)).stage, 'sleeping');
      assert.deepEqual(events, [], 'runtime status must not acquire a graph lease');

      assert.deepEqual(await getJson(`${url}/api/state`), { ready: true });
      assert.deepEqual(events, [
        ['enter', 'http:GET:/api/state'],
        ['leave', 'http:GET:/api/state']
      ]);
      await getJson(`${url}/api/external-knowledge/bindings`);
      assert.equal(events.length, 2, 'read-only binding configuration must not wake the graph');
      await requestJson(`${url}/api/external-knowledge/bindings/source-a/sync`, {
        method: 'POST', body: {}
      });
      assert.deepEqual(events.slice(2), [
        ['enter', 'http:POST:/api/external-knowledge/bindings/source-a/sync'],
        ['leave', 'http:POST:/api/external-knowledge/bindings/source-a/sync']
      ]);

      const acquired = await requestJson(`${url}/api/system/runtime/leases`, {
        method: 'POST',
        body: { kind: 'executor', executorId: 'local-coder', owner: 'test' }
      });
      assert.equal(acquired.status, 201);
      assert.equal(acquired.body.leaseId, leaseId);
      assert.equal((await requestJson(`${url}/api/system/runtime/leases/${leaseId}`, {
        method: 'PATCH',
        body: {}
      })).body.refreshed, true);
      assert.equal((await requestJson(`${url}/api/system/runtime/leases/${leaseId}`, {
        method: 'DELETE'
      })).body.released, true);
    } finally {
      await closeServer(server);
    }
  });
