import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { mapHttpError } from '../src/http/error-mapping.js';
import { handleTaskSchedulesRequest } from '../src/http/task-schedules-api-router.js';
import { createTaskScheduleService } from '../src/task-schedules/service.js';
import { listenFetchableServer } from '../src/server/listen.js';

const SPACE = 'space-1';

async function withServer(fn) {
  const app = { config: { personal: { spaceId: SPACE } },
    async submitProjectAgentTask() { return { task: { taskId: 'task-1', status: 'backlog' } }; },
    async viewProjectAgentTask({ taskId }) { return { taskId, status: 'backlog' }; } };
  app.taskSchedules = createTaskScheduleService({ app });
  const server = createServer(async (request, response) => {
    try {
      if (!await handleTaskSchedulesRequest({ request, response, url: new URL(request.url, 'http://local'), app })) {
        response.writeHead(404).end();
      }
    } catch (error) {
      const mapped = mapHttpError(error);
      response.writeHead(mapped.status, { 'content-type': 'application/json' }).end(JSON.stringify(mapped.body));
    }
  });
  await listenFetchableServer(server, 0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  try { await fn(call); } finally { app.taskSchedules.close(); server.close(); }
}

test('the console manages schedules over HTTP with the same rules as the Agent tool', async () => {
  await withServer(async call => {
    const created = await call('POST', '/api/task-schedules', { personalSpaceId: SPACE, personalProjectId: 'project-a',
      title: 'Nightly check', objective: 'Run the checks.', workKind: 'verification',
      every: { unit: 'hours', count: 24 }, startMode: 'backlog' });
    assert.equal(created.status, 200);
    assert.equal(created.body.enabled, true);
    const listed = await call('GET', `/api/task-schedules?personalSpaceId=${SPACE}&personalProjectId=project-a`);
    assert.deepEqual(listed.body.schedules.map(item => item.id), [created.body.id]);
    const paused = await call('POST', `/api/task-schedules/${created.body.id}/pause`,
      { personalSpaceId: SPACE, expectedRevision: created.body.revision });
    assert.equal(paused.body.pausedReason, 'paused_by_user');
    const stale = await call('POST', `/api/task-schedules/${created.body.id}/resume`,
      { personalSpaceId: SPACE, expectedRevision: created.body.revision });
    assert.deepEqual([stale.status, stale.body.code], [409, 'task_schedule_conflict']);
    const missing = await call('GET', `/api/task-schedules/unknown/runs?personalSpaceId=${SPACE}`);
    assert.deepEqual([missing.status, missing.body.code], [404, 'task_schedule_not_found']);
    const runs = await call('GET', `/api/task-schedules/${created.body.id}/runs?personalSpaceId=${SPACE}`);
    assert.deepEqual(runs.body, { runs: [] });
    const tooOften = await call('POST', '/api/task-schedules', { personalSpaceId: SPACE, personalProjectId: 'project-a',
      title: 't', objective: 'o', workKind: 'w', every: { unit: 'minutes', count: 5 } });
    assert.equal(tooOften.status, 400);
    assert.equal((await call('POST', `/api/task-schedules/${created.body.id}/delete`, { personalSpaceId: SPACE })).status, 404);
  });
});
