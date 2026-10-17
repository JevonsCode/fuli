import assert from 'node:assert/strict';
import test from 'node:test';

import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { handleGraphApiRequest } from '../src/http/graph-api-router.js';

// HTTP Provider double and synthetic identifiers only.
const SPACE = 'test-space';
const config = { version: 1, workspaces: [],
  personal: { providerUrl: 'http://127.0.0.1:8787', accessToken: 'synthetic-provider-token', principalId: 'test-person', spaceId: SPACE } };
const agent = (id) => ({ agent_id: id, personal_space_id: SPACE, profile: { name: id, responsibility: 'Synthetic.' },
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-17T00:00:00Z' });

test('the console reads one roster page and keeps the cursor and completeness exactly', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(new URL(url));
    return Response.json({ items: [agent('alpha'), agent('bravo')], next_cursor: 'opaque-next', complete: false });
  };
  const app = new FederatedGraphApplication(config, { fetchImpl });
  let status; let body;
  const response = { writeHead(code) { status = code; }, end(text) { body = JSON.parse(text); } };
  const url = new URL(`http://127.0.0.1/api/project-agent-pages?personalSpaceId=${SPACE}&limit=2&work=open&cursor=opaque-prev`);
  assert.equal(await handleGraphApiRequest({ request: { method: 'GET' }, response, url, app }), true);
  assert.equal(status, 200);
  assert.equal(urls[0].pathname, '/v1/project-agent-pages');
  assert.deepEqual(Object.fromEntries(urls[0].searchParams), {
    personal_space_id: SPACE, work: 'open', limit: '2', cursor: 'opaque-prev'
  });
  assert.deepEqual(body.items.map((item) => item.agentId), ['alpha', 'bravo']);
  assert.equal(body.nextCursor, 'opaque-next');
  assert.equal(body.complete, false);
  await assert.rejects(app.listProjectAgentPage({ personalSpaceId: 'other-space' }));
  assert.equal(urls.length, 1);
});

test('a page without an explicit complete flag is never reported complete', async () => {
  const app = new FederatedGraphApplication(config, { fetchImpl: async () => Response.json({ items: [] }) });
  const page = await app.listProjectAgentPage({ personalSpaceId: SPACE });
  assert.equal(page.complete, false);
});
