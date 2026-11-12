import { readJson, sendJson } from './response.js';
import { delegatedCall } from './agent-delegation-gate.js';
import { refuseRemoteDecision } from './request-policy.js';
import { validationError } from '../app/application-error.js';
import { requiredString } from '../validation/values.js';

const CLOSE_PATH = /^\/api\/project-agent-tasks\/([^/]+)\/close$/;
const STATUSES = new Set(['completed', 'cancelled']);
const MAX_ID = 128;
const MAX_NOTE = 1000;
const PERSON_SUMMARY = 'Closed by the person in FULI.';

// The person completes or cancels a task themself (rec#123). An FLA relays
// the person's words with run_delegated_action; the delegation gate admits it
// only with those words found in the person's recent messages and only while
// Settings › AI permissions › Relay your decisions is on, and records it. The
// task's history then carries the person's words and names the FLA that
// relayed them. Accepted only on this computer.
export async function handleTaskCloseRequest({ request, response, url, app, closeConsole }) {
  const match = url.pathname.match(CLOSE_PATH);
  if (!match || request.method !== 'POST') return false;
  response.setHeader('Cache-Control', 'no-store');
  if (refuseRemoteDecision(request, response, 'Tasks are closed by the person only on this computer')) return true;
  if (!closeConsole) {
    sendJson(response, 503, { error: 'Closing a task needs a local FULI installation' });
    return true;
  }
  const body = await readJson(request);
  if (body?.personalSpaceId !== app.config.personal.spaceId) {
    throw validationError('Tasks are closed in the active personal space');
  }
  const taskId = requiredString(decodeURIComponent(match[1]), 'taskId', MAX_ID);
  const personalProjectId = requiredString(body.personalProjectId, 'personalProjectId', MAX_ID);
  if (!STATUSES.has(body.status)) throw validationError('status must be completed or cancelled');
  const blank = body.note == null || (typeof body.note === 'string' && !body.note.trim());
  const note = blank ? null : requiredString(body.note, 'note', MAX_NOTE);
  const call = delegatedCall(request);
  // A relayed close is the person's words, then what the relaying FLA adds.
  const summary = call?.relayed ? [`「${call.relayed.words}」`, note].filter(Boolean).join(' ') : note ?? PERSON_SUMMARY;
  const relayer = call ? { agentId: call.actor.agentId, client: call.actor.client, sessionId: call.actor.sessionId } : null;
  sendJson(response, 200, await closeConsole.closeAsPerson(taskId,
    { personalSpaceId: body.personalSpaceId, personalProjectId, status: body.status, summary, relayer }));
  return true;
}
