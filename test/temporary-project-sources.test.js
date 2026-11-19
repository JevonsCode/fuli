import assert from 'node:assert/strict';
import test from 'node:test';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { handleGraphApiRequest } from '../src/http/graph-api-router.js';

// The console's on-demand read of who made each session temporary project.
// Synthetic Provider answers; nothing leaves the test.
const SPACE = 'synthetic-space';
const config = { version: 1, workspaces: [],
  personal: { providerUrl: 'http://127.0.0.1:8787', accessToken: 'synthetic-provider-token', principalId: 'synthetic-person', spaceId: SPACE } };
const SOURCES = [{ personal_project_id: `temporary-${'a'.repeat(64)}`, source_application: 'codex', session_id: 'synthetic-native-17' }];

function application() {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(new URL(url));
    return Response.json(SOURCES);
  };
  return { app: new FederatedGraphApplication(config, { fetchImpl }), requests };
}

async function get(app, path) {
  let status = null;
  let body = '';
  const response = { writeHead(code) { status = code; }, end(text) { body = text; }, setHeader() {} };
  const handled = await handleGraphApiRequest({ request: { method: 'GET', headers: {} }, response,
    url: new URL(path, 'http://127.0.0.1'), app });
  return { handled, status, body: body ? JSON.parse(body) : null };
}

test('GET /api/personal-projects/temporary-sources reads the active space from the Provider, on its own route', async () => {
  const { app, requests } = application();
  const answer = await get(app, `/api/personal-projects/temporary-sources?personalSpaceId=${SPACE}`);
  assert.deepEqual([answer.handled, answer.status, answer.body], [true, 200, SOURCES]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].pathname, '/v1/personal-projects/temporary-sources');
  assert.equal(requests[0].searchParams.get('personal_space_id'), SPACE);
  // Without a space it reads the active one; another space is refused before any request.
  assert.equal((await get(app, '/api/personal-projects/temporary-sources')).status, 200);
  await assert.rejects(get(app, '/api/personal-projects/temporary-sources?personalSpaceId=other-space'), TypeError);
  assert.equal(requests.length, 2);
});
