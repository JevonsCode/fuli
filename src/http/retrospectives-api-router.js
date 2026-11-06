import { taskRetrospective } from '../retrospectives/runs.js';
import { requiredString } from '../validation/values.js';
import { refuseRemoteDecision } from './request-policy.js';
import { sendJson } from './response.js';

// A finished task's retrospective (src/retrospectives/), for the task's view.
// Read only and only on this computer: it holds what Astro's model wrote.
const PATH = '/api/retrospectives';

export async function handleRetrospectivesRequest({ request, response, url, app }) {
  if (url.pathname !== PATH) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (refuseRemoteDecision(request, response, 'Retrospectives are read only on this computer')) return true;
  if (request.method !== 'GET') { sendJson(response, 405, { error: 'Method not allowed' }); return true; }
  const taskId = requiredString(url.searchParams.get('taskId'), 'taskId', 256);
  sendJson(response, 200, { retrospective: await taskRetrospective(app, taskId) });
  return true;
}
