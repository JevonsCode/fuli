import { readJson, sendJson } from './response.js';
import { refuseRemoteDecision } from './request-policy.js';
import { validationError } from '../app/application-error.js';
import { requiredString } from '../validation/values.js';

const CLEAR_PATH = /^\/api\/project-agent-tasks\/([^/]+)\/blocker\/clear$/;
const MAX_ID = 128;
const MAX_NOTE = 500;

// The person marks a blocked task as no longer blocked (「标记为已解除」), with
// an optional short note. Accepted only on this computer and sent on the
// human-review channel (src/task-blockers), so an Agent can never post it,
// not even straight to the Provider with its own token. No Agent tool
// reaches this route.
export async function handleTaskBlockerRequest({ request, response, url, app, blockerConsole }) {
  const match = url.pathname.match(CLEAR_PATH);
  if (!match || request.method !== 'POST') return false;
  response.setHeader('Cache-Control', 'no-store');
  if (refuseRemoteDecision(request, response, 'Blocked tasks are marked unblocked only on this computer')) return true;
  if (!blockerConsole) {
    sendJson(response, 503, { error: 'Marking a task unblocked needs a local FULI installation' });
    return true;
  }
  const body = await readJson(request);
  if (body?.personalSpaceId !== app.config.personal.spaceId) {
    throw validationError('Tasks are marked unblocked in the active personal space');
  }
  const taskId = requiredString(decodeURIComponent(match[1]), 'taskId', MAX_ID);
  const personalProjectId = requiredString(body.personalProjectId, 'personalProjectId', MAX_ID);
  const blank = body.note == null || (typeof body.note === 'string' && !body.note.trim());
  const note = blank ? null : requiredString(body.note, 'note', MAX_NOTE);
  sendJson(response, 200, await blockerConsole.markUnblocked(taskId,
    { personalSpaceId: body.personalSpaceId, personalProjectId, note }));
  return true;
}
