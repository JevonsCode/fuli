import assert from 'node:assert/strict';
import test from 'node:test';

import { createServer } from '../src/server.js';
import { closeServer, getJson, requestJson } from '../test-support/server.js';

test('server exposes read-only knowledge bindings, sync, retrieval, and conflict policy routes', async () => {
  const calls = [];
  const externalKnowledge = {
    listConnectorTypes: () => [{ type: 'mcp', name: 'MCP' }],
    listBindings: async () => [{ id: 'binding-1', name: 'Docs' }],
    createBinding: async (input) => {
      calls.push(['create', input]);
      return { id: 'binding-2', ...input };
    },
    discover: async (input) => {
      calls.push(['discover', input]);
      return { items: [{ id: 'page-1' }] };
    },
    checkBinding: async (id) => ({ bindingId: id, status: 'ready' }),
    syncBinding: async (id) => ({ bindingId: id, imported: 2 }),
    retrieveBinding: async (id, input) => ({ bindingId: id, ...input, items: [] }),
    updateBindingTargets: async (id, input) => {
      calls.push(['targets', id, input]);
      return { id, ...input };
    },
    deleteBinding: async (id) => ({ bindingId: id, status: 'deleted' })
  };
  const connectedKnowledge = {
    getConflictPolicy: ({ personalProjectId }) => ({
      personalProjectId,
      mode: 'ask_human'
    }),
    updateConflictPolicy: async (input) => {
      calls.push(['policy', input]);
      return { personalProjectId: input.personalProjectId, mode: input.mode };
    },
    query: async (input) => {
      calls.push(['query', input]);
      return { query: input.query, graph: {}, external: [] };
    }
  };
  const app = {
    graphiti: true,
    state: async () => ({ mode: 'graphiti' }),
    close() {}
  };
  const { server, url } = await createServer({
    app,
    externalKnowledge,
    connectedKnowledge,
    port: 0
  });

  try {
    assert.equal((await getJson(`${url}/api/external-knowledge/connectors`))[0].type, 'mcp');
    assert.equal((await getJson(`${url}/api/external-knowledge/bindings`))[0].id, 'binding-1');
    const created = await requestJson(`${url}/api/external-knowledge/bindings`, {
      method: 'POST',
      body: { name: 'Wiki', connectorType: 'mcp' }
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.id, 'binding-2');

    const discovered = await requestJson(`${url}/api/external-knowledge/discover`, {
      method: 'POST',
      body: { connectorType: 'notion', query: 'handbook' }
    });
    assert.equal(discovered.body.items[0].id, 'page-1');

    assert.equal((await requestJson(
      `${url}/api/external-knowledge/bindings/binding-1/check`,
      { method: 'POST', body: {} }
    )).body.status, 'ready');
    assert.equal((await requestJson(
      `${url}/api/external-knowledge/bindings/binding-1/sync`,
      { method: 'POST', body: {} }
    )).body.imported, 2);
    assert.equal((await requestJson(
      `${url}/api/external-knowledge/bindings/binding-1/retrieve`,
      { method: 'POST', body: { query: 'release', limit: 5 } }
    )).body.query, 'release');
    const targetInput = {
      targets: [{
        personalSpaceId: 'personal-1',
        personalProjectId: 'project-a',
        mode: 'live'
      }]
    };
    assert.deepEqual((await requestJson(
      `${url}/api/external-knowledge/bindings/binding-1/targets`,
      { method: 'PATCH', body: targetInput }
    )).body.targets, targetInput.targets);
    assert.deepEqual(calls.find(([kind]) => kind === 'targets'), [
      'targets', 'binding-1', targetInput
    ]);

    const policyUrl = `${url}/api/external-knowledge/conflict-policy?personalProjectId=project-a`;
    assert.equal((await getJson(policyUrl)).mode, 'ask_human');
    assert.equal((await requestJson(policyUrl, {
      method: 'PATCH',
      body: {
        personalSpaceId: 'personal-1',
        personalProjectId: 'project-a',
        mode: 'agent_decide'
      }
    })).body.mode, 'agent_decide');

    assert.equal((await requestJson(`${url}/api/connected-knowledge/search`, {
      method: 'POST',
      body: { personalProjectId: 'project-a', query: 'release' }
    })).body.query, 'release');
    assert.equal((await requestJson(
      `${url}/api/external-knowledge/bindings/binding-1`,
      { method: 'DELETE' }
    )).body.status, 'deleted');
  } finally {
    await closeServer(server);
  }
});
