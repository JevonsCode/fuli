import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { handleGraphApiRequest } from '../src/http/graph-api-router.js';
import { projectAgentRecord } from '../src/graphiti/project-agent-mapping.js';
import { projectAgentOccupation } from '../src/agent-tools/project-agent-definitions.js';

const config = { version: 1, workspaces: [], personal: {
  providerUrl: 'http://127.0.0.1:8787', accessToken: 'synthetic-test-token',
  principalId: 'fixture-person', spaceId: 'fixture-space'
} };

test('occupation HTTP operations use the personal Provider and preserve the catalog contract', async () => {
  const calls = [];
  const item = { key: 'custom_123', name_zh: '维护', name_en: 'Maintenance',
    description_zh: '维护服务并处理明确的问题。', description_en: 'Maintain services and resolve issues.',
    builtin: false, status: 'active', revision: 1, agent_count: 2 };
  const app = new FederatedGraphApplication(config, { fetchImpl: async (url, options = {}) => {
    calls.push({ path: new URL(url).pathname, method: options.method ?? 'GET',
      body: options.body ? JSON.parse(options.body) : null, query: new URL(url).search });
    return Response.json(options.method && options.method !== 'GET' ? item : [item]);
  } });
  for (const [method, path, input] of [
    ['GET', '/api/occupations?personalSpaceId=fixture-space', null],
    ['POST', '/api/occupations', { name_zh: '维护', description_zh: '维护服务并处理明确的问题。' }],
    ['PUT', '/api/occupations/custom_123', { revision: 1, name_zh: '维护服务' }],
    ['POST', '/api/occupations/custom_123/archive', { revision: 1 }],
    ['DELETE', '/api/occupations/custom_123', { revision: 1 }]
  ]) {
    const request = Readable.from(input ? [Buffer.from(JSON.stringify({ personalSpaceId: 'fixture-space', ...input }))] : []);
    request.method = method; request.headers = { 'content-type': 'application/json' };
    let code; let result;
    const response = { writeHead(value) { code = value; }, end(value) { result = JSON.parse(value); } };
    assert.equal(await handleGraphApiRequest({ request, response, url: new URL(path, 'http://fixture'), app }), true);
    assert.equal(code, 200);
    assert.deepEqual(result, method === 'GET' ? [item] : item);
  }
  assert.deepEqual(calls.map(c => [c.method, c.path]), [
    ['GET', '/v1/occupations'], ['POST', '/v1/occupations'],
    ['PUT', '/v1/occupations/custom_123'], ['POST', '/v1/occupations/custom_123/archive'],
    ['DELETE', '/v1/occupations/custom_123']
  ]);
  assert.equal(calls[0].query, '?personal_space_id=fixture-space');
  assert.equal(calls[1].body.personal_space_id, 'fixture-space');
  assert.equal(Object.hasOwn(calls[1].body, 'personalSpaceId'), false);
  await assert.rejects(app.occupationCatalog('list', { personalSpaceId: 'another-space' }));
  assert.equal(calls.length, 5);
});

test('custom occupation keys fit the existing Agent schema without adding descriptions to it', () => {
  assert.equal(projectAgentOccupation.properties.role.enum, undefined);
  assert.match('custom_0123456789abcdef0123456789abcdef', new RegExp(projectAgentOccupation.properties.role.pattern));
  assert.deepEqual(projectAgentOccupation.required, ['role']);
  assert.equal(JSON.stringify(projectAgentOccupation).includes('description_zh'), false);
});

test('the UI record projects the Provider occupation lock without inventing one for an old Provider', () => {
  const base = { agent_id: 'employee.bole', profile: {}, personal_space_id: 'fixture-space' };
  assert.equal(projectAgentRecord({ ...base, occupation_locked: true }).occupationLocked, true);
  assert.equal(Object.hasOwn(projectAgentRecord(base), 'occupationLocked'), false);
});

test('structured Provider errors preserve a stable occupation error code', async () => {
  const app = new FederatedGraphApplication(config, { fetchImpl: async () =>
    Response.json({ detail: { code: 'occupation_locked', message: 'The built-in occupation is locked.' } }, { status: 409 }) });
  await assert.rejects(app.updateProjectAgentOccupation({ personalSpaceId: 'fixture-space', agentId: 'employee.bole', role: 'testing' }),
    error => error.status === 409 && error.code === 'occupation_locked' && /locked/.test(error.message));
});
