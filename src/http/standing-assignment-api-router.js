import { readJson, sendJson } from './response.js';
import { refuseRemoteDecision } from './request-policy.js';
import { correctStandingAssignmentInConsole } from '../graphiti/standing-assignment-correction.js';
import { createWorkstreamInConsole } from '../graphiti/standing-assignment-workstream.js';
import { agentWorkstreamLedger } from '../graphiti/agent-workstream-ledger.js';
import { positiveInteger, requiredString } from '../validation/values.js';

const AGENT_ID_LIMIT = 200;

const LIST_PATH = '/api/standing-assignments';
const LEDGER_PATH = '/api/workstreams';
const CHANGE_PATH = /^\/api\/standing-assignments\/([^/]+)\/(retire|reassign|terms)$/;
const ACTIONS = Object.freeze({ retire: 'retire', reassign: 'reassign', terms: 'edit_terms' });

// The person's standing assignments in the local console (rec#29 F5): the
// active ones, opening a workstream on a project page
// (docs/workstreams.md), and ending, reassigning or editing the terms of the
// one the page shows, at the revision it showed (409 when it changed since; a
// change already in place, such as a retry, answers unchanged). Only on
// this computer; an Agent asks the person through register_standing_assignment
// instead, which previews and needs the person's yes in the conversation.
export async function handleStandingAssignmentRequest({ request, response, url, app }) {
  const change = url.pathname.match(CHANGE_PATH);
  const list = url.pathname === LIST_PATH && request.method === 'GET';
  const create = url.pathname === LIST_PATH && request.method === 'POST';
  const ledger = url.pathname === LEDGER_PATH && request.method === 'GET';
  if (!list && !create && !ledger && !(change && request.method === 'POST')) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (refuseRemoteDecision(request, response, 'Standing assignments are changed only on this computer')) return true;
  if (!app.standingAssignments) {
    sendJson(response, 503, { error: 'Standing assignments need a local FULI installation' });
    return true;
  }
  if (list) {
    sendJson(response, 200, { assignments: app.standingAssignments.list(app.config.personal.spaceId) });
    return true;
  }
  // One FLA's ledger for the console widget: the lines of the projects it
  // leads, and the lines it owns, each with how far it got.
  if (ledger) {
    sendJson(response, 200, await agentWorkstreamLedger(app, app.config.personal.spaceId,
      requiredString(url.searchParams.get('agentId'), 'agentId', AGENT_ID_LIMIT)));
    return true;
  }
  const body = await readJson(request);
  if (create) {
    sendJson(response, 200, await createWorkstreamInConsole(app, body));
    return true;
  }
  sendJson(response, 200, await correctStandingAssignmentInConsole(app, { ...body,
    assignmentId: decodeURIComponent(change[1]), action: ACTIONS[change[2]],
    expectedRevision: positiveInteger(body.expectedRevision, 'expectedRevision', Number.MAX_SAFE_INTEGER) }));
  return true;
}
