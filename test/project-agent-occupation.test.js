import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { handleGraphApiRequest } from '../src/http/graph-api-router.js';

// HTTP Provider double and synthetic identifiers only.
const SPACE = 'test-space';
const config = { version: 1, workspaces: [],
  personal: { providerUrl: 'http://127.0.0.1:8787', accessToken: 'synthetic-provider-token', principalId: 'test-person', spaceId: SPACE } };

function agentRecord(occupation) {
  return { agent_id: 'engineer', personal_space_id: SPACE,
    profile: { name: 'Engineer', status: 'active', responsibility: 'Maintain the sample service.' },
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-17T00:00:00Z',
    ...(occupation === undefined ? {} : { occupation }) };
}

function jsonRequest(method, body) {
  const request = Readable.from([Buffer.from(JSON.stringify(body))]);
  request.method = method;
  request.headers = { 'content-type': 'application/json' };
  return request;
}

test('the console sends one explicit occupation edit and maps the stored result', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const target = new URL(url);
    calls.push({ method: options.method ?? 'GET', path: target.pathname, body: options.body ? JSON.parse(options.body) : null });
    return Response.json(agentRecord({ role: 'design', tags: ['research'], updated_at: '2026-10-17T05:00:00Z' }));
  };
  const app = new FederatedGraphApplication(config, { fetchImpl });
  let status; let body;
  const response = { writeHead(code) { status = code; }, end(text) { body = JSON.parse(text); } };
  const url = new URL('http://127.0.0.1/api/project-agents/engineer/occupation');
  const handled = await handleGraphApiRequest({
    request: jsonRequest('PUT', { personalSpaceId: SPACE, role: 'design', tags: ['research'] }),
    response, url, app
  });
  assert.equal(handled, true);
  assert.equal(status, 200);
  assert.deepEqual(calls, [{
    method: 'PUT', path: '/v1/project-agents/engineer/occupation',
    body: { personal_space_id: SPACE, role: 'design', tags: ['research'] }
  }]);
  assert.deepEqual(body.occupation, { role: 'design', tags: ['research'], updatedAt: '2026-10-17T05:00:00Z' });

  await assert.rejects(app.updateProjectAgentOccupation({ personalSpaceId: 'other-space', agentId: 'engineer', role: null, tags: [] }));
  assert.equal(calls.length, 1);
});

test('an Agent no one has classified keeps a null occupation; older providers omit it', async () => {
  const { projectAgentRecord } = await import('../src/graphiti/project-agent-mapping.js');
  assert.equal(projectAgentRecord(agentRecord(null)).occupation, null);
  assert.equal(Object.hasOwn(projectAgentRecord(agentRecord()), 'occupation'), false);
});
