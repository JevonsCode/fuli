import { taskVerification } from '../fla-growth/task-verification.js';
import { sendJson } from './response.js';

const PATH = /^\/api\/project-agent-tasks\/([^/]+)\/verification$/;

// A task outcome's verification state (rec#78), for its acceptance view.
export async function handleTaskVerificationRequest({ request, response, url, app }) {
  const match = url.pathname.match(PATH);
  if (!match || request.method !== 'GET') return false;
  sendJson(response, 200, await taskVerification(app, {
    personalSpaceId: url.searchParams.get('personalSpaceId'),
    personalProjectId: url.searchParams.get('personalProjectId'),
    taskId: decodeURIComponent(match[1])
  }));
  return true;
}
