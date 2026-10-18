import test from 'node:test';
import assert from 'node:assert/strict';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { handleGraphApiRequest } from '../src/http/graph-api-router.js';

const observations = [
  { source_project_id: 'a', target_project_id: 'b', statistics: { tier: 'related', recent30dCount: 0, totalCount: 2 } },
  { source_project_id: 'b', target_project_id: 'a', statistics: { tier: 'frequent', recent30dCount: 3, totalCount: 4 } },
  { source_project_id: 'a', target_project_id: 'c', statistics: { tier: 'close', recent30dCount: 10, totalCount: 12 } }
];
const expected = [
  { fromProjectId: 'a', toProjectId: 'b', tier: 'related', recent30dCount: 0 },
  { fromProjectId: 'b', toProjectId: 'a', tier: 'frequent', recent30dCount: 3 },
  { fromProjectId: 'a', toProjectId: 'c', tier: 'close', recent30dCount: 10 }
];
function application(result = observations, status = 200) {
  const calls = [];
  const app = new FederatedGraphApplication({ version: 1, personal: {
    providerUrl: 'http://127.0.0.1:1234', accessToken: 'synthetic-token',
    principalId: 'synthetic-user', spaceId: 'space'
  }, workspaces: [] }, { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    assert.equal(url, 'http://127.0.0.1:1234/v1/project-memory-usage?personal_space_id=space');
    assert.equal(options.method ?? 'GET', 'GET');
    assert.equal(options.headers.authorization ?? options.headers.Authorization, 'Bearer synthetic-token');
    return new Response(JSON.stringify(result), { status, headers: { 'content-type': 'application/json' } });
  } });
  return { app, calls };
}

test('light relation weights read one authenticated aggregate without loading any graph or granting access', async () => {
  const { app, calls } = application();
  try {
    assert.deepEqual(await app.listProjectRelationWeights({ personalSpaceId: 'space' }), expected);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.body, undefined);
  } finally { await app.close(); }
});

test('the HTTP read returns the compact directional array and allows the configured space default', async () => {
  const { app, calls } = application();
  try {
    for (const query of ['', '?personalSpaceId=space']) {
      let body, status;
      const handled = await handleGraphApiRequest({ request: { method: 'GET' },
        url: new URL('http://127.0.0.1/api/projects/relation-weights' + query), app,
        response: { writeHead(code) { status = code; }, end(value) { body = value; } } });
      assert.equal(handled, true);
      assert.equal(status, 200);
      assert.deepEqual(JSON.parse(body), expected);
    }
    assert.equal(calls.length, 2);
    assert.equal(await handleGraphApiRequest({ request: { method: 'POST' }, app, response: {},
      url: new URL('http://127.0.0.1/api/projects/relation-weights') }), false);
    assert.equal(calls.length, 2);
  } finally { await app.close(); }
});

test('another personal space is rejected before contacting the Provider', async () => {
  const { app, calls } = application();
  try {
    await assert.rejects(app.listProjectRelationWeights({ personalSpaceId: 'foreign' }), /active personal space/);
    assert.equal(calls.length, 0);
  } finally { await app.close(); }
});

test('empty observations stay empty and Provider authorization failure is propagated', async () => {
  const empty = application([]);
  try { assert.deepEqual(await empty.app.listProjectRelationWeights(), []); }
  finally { await empty.app.close(); }
  const denied = application({ detail: 'Forbidden synthetic space' }, 403);
  try { await assert.rejects(denied.app.listProjectRelationWeights(), { status: 403 }); }
  finally { await denied.app.close(); }
});
