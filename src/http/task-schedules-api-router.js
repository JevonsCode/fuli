import { readJson, sendJson } from './response.js';

const SCHEDULE_ACTIONS = new Set(['update', 'pause', 'resume']);

// Console routes for scheduled tasks; the same service backs the
// manage_project_agent_schedule tool, so both paths share validation.
export async function handleTaskSchedulesRequest({ request, response, url, app }) {
  if (url.pathname === '/api/task-schedules' && request.method === 'GET') {
    sendJson(response, 200, app.taskSchedules.manage({ action: 'list',
      personalSpaceId: url.searchParams.get('personalSpaceId'),
      personalProjectId: url.searchParams.get('personalProjectId') }));
    return true;
  }
  if (url.pathname === '/api/task-schedules' && request.method === 'POST') {
    sendJson(response, 200, await app.taskSchedules.manage({ ...await readJson(request), action: 'create' }));
    return true;
  }
  const runsPath = url.pathname.match(/^\/api\/task-schedules\/([^/]+)\/runs$/);
  if (runsPath && request.method === 'GET') {
    sendJson(response, 200, app.taskSchedules.manage({ action: 'runs',
      personalSpaceId: url.searchParams.get('personalSpaceId'), scheduleId: decodeURIComponent(runsPath[1]) }));
    return true;
  }
  const actionPath = url.pathname.match(/^\/api\/task-schedules\/([^/]+)\/([a-z]+)$/);
  if (actionPath && SCHEDULE_ACTIONS.has(actionPath[2]) && request.method === 'POST') {
    sendJson(response, 200, app.taskSchedules.manage({ ...await readJson(request), action: actionPath[2],
      scheduleId: decodeURIComponent(actionPath[1]) }));
    return true;
  }
  return false;
}
