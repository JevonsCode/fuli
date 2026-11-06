import assert from 'node:assert/strict';
import test from 'node:test';

import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { handleGraphApiRequest } from '../src/http/graph-api-router.js';

// HTTP Provider double and synthetic identifiers only.
const SPACE = 'test-space';
const config = { version: 1, workspaces: [],
  personal: { providerUrl: 'http://127.0.0.1:8787', accessToken: 'synthetic-provider-token', principalId: 'test-person', spaceId: SPACE } };
const task = (id) => ({ task_id: id, personal_space_id: SPACE, personal_project_id: 'project-a', title: `Synthetic ${id}`,
  objective: 'Synthetic objective.', status: 'running', created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-02T00:00:00Z' });

async function get(app, path) {
  let status; let body;
  const response = { writeHead(code) { status = code; }, end(text) { body = JSON.parse(text); } };
  assert.equal(await handleGraphApiRequest({ request: { method: 'GET' }, response, url: new URL(`http://127.0.0.1${path}`), app }), true);
  return { status, body };
}

test('the console reads one filtered task page and passes every filter through', async () => {
  const urls = [];
  const app = new FederatedGraphApplication(config, { fetchImpl: async (url) => {
    urls.push(new URL(url));
    return Response.json({ items: [task('task-1'), task('task-2')], next_cursor: 'opaque-next', total: 41 });
  } });
  const { status, body } = await get(app, `/api/project-agent-task-pages?personalSpaceId=${SPACE}&status=running&status=blocked`
    + '&project=project-a&agent=ada&q=needle&since=2026-11-01T00%3A00%3A00.000Z&order=completed&sort=oldest&limit=2&cursor=opaque-prev');
  assert.equal(status, 200);
  assert.equal(urls[0].pathname, '/v1/project-agent-task-pages');
  assert.deepEqual([...urls[0].searchParams], [
    ['personal_space_id', SPACE], ['status', 'running'], ['status', 'blocked'], ['project', 'project-a'], ['agent', 'ada'],
    ['text', 'needle'], ['since', '2026-11-01T00:00:00.000Z'], ['order', 'completed'], ['sort', 'oldest'], ['limit', '2'], ['cursor', 'opaque-prev'],
  ]);
  assert.deepEqual(body.items.map((item) => item.taskId), ['task-1', 'task-2']);
  assert.equal(body.nextCursor, 'opaque-next');
  assert.equal(body.total, 41);
});

test('a later page carries no total and another space is refused before any read', async () => {
  const urls = [];
  const app = new FederatedGraphApplication(config, { fetchImpl: async (url) => {
    urls.push(url);
    return Response.json({ items: [], next_cursor: null, total: null });
  } });
  const page = await app.listProjectAgentTaskPage({ personalSpaceId: SPACE, statuses: ['completed'], cursor: 'opaque' });
  assert.deepEqual(page, { items: [], nextCursor: null, total: null });
  await assert.rejects(app.listProjectAgentTaskPage({ personalSpaceId: 'other-space', statuses: ['completed'] }));
  assert.equal(urls.length, 1);
});
