import { readJson, sendJson } from './response.js';
import { delegatedCall } from './agent-delegation-gate.js';
import { refuseRemoteDecision } from './request-policy.js';
import { validationError } from '../app/application-error.js';
import { requiredString } from '../validation/values.js';
import { RESUME_STATUSES } from '../task-blockers/resume-status.js';

const CLEAR_PATH = /^\/api\/project-agent-tasks\/([^/]+)\/blocker\/clear$/;
const MAX_ID = 128;
const MAX_NOTE = 500;

// The person marks a blocked task as no longer blocked (「标记为已解除」), with
// an optional short note, or confirms a block FULI saw as probably resolved
// (confirmHint). Accepted only on this computer and sent on the human-review
// channel (src/task-blockers), so no Agent posts it straight to the Provider
// with its own token. An FLA that solved the block makes the same change for
// the person only through run_delegated_action (rec#11 D-81), which the
// delegation gate admits while the person keeps that permission on; the clear
// then names the FLA and its reason instead of the person.
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
  if (body.confirmHint != null && typeof body.confirmHint !== 'boolean') {
    throw validationError('confirmHint must be true or false');
  }
  // An FLA resuming the task from its own report may put it back in its queue (rec#123).
  if (body.resumeStatus != null && !RESUME_STATUSES.has(body.resumeStatus)) {
    throw validationError('resumeStatus must be running or queued');
  }
  const call = delegatedCall(request);
  const clearer = call
    ? { agent: { agentId: call.actor.agentId, client: call.actor.client, sessionId: call.actor.sessionId },
      note: note ?? call.reason }
    : { confirmHint: body.confirmHint === true, note };
  sendJson(response, 200, await blockerConsole.markUnblocked(taskId,
    { personalSpaceId: body.personalSpaceId, personalProjectId, resumeStatus: body.resumeStatus ?? null, ...clearer }));
  return true;
}
