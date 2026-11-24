import { readJson, sendJson } from './response.js';
import { refuseRemoteDecision } from './request-policy.js';
import { delegatedCall } from './agent-delegation-gate.js';
import { correctStandingAssignmentInConsole } from '../graphiti/standing-assignment-correction.js';
import { mergeWorkstreamsInConsole, openWorkstreamInConsole, splitWorkstreamInConsole }
  from '../graphiti/standing-assignment-workstream.js';
import { agentWorkstreamLedger, projectWorkstreamLedger } from '../graphiti/agent-workstream-ledger.js';
import { ID_LIMIT } from '../standing-assignments/limits.js';
import { positiveInteger, requiredString } from '../validation/values.js';

const LIST_PATH = '/api/standing-assignments';
const LEDGER_PATH = '/api/workstreams';
const CHANGE_PATH = /^\/api\/standing-assignments\/([^/]+)\/(retire|reassign|terms|merge|split)$/;
const CORRECTIONS = Object.freeze({ retire: 'retire', reassign: 'reassign', terms: 'edit_terms' });

// The person's standing assignments and workstreams in the local console
// (rec#29 F5, docs/workstreams.md): the active ones, a project's or one FLA's
// ledger, opening a line, merging or splitting lines as one change each, and
// ending, reassigning or editing the terms of the one the page shows, at the
// revision it showed (409 when it changed since; a change already in place
// answers unchanged). Only on this computer. A click is the person's; an FLA
// acting for them (run_delegated_action) is recorded as an Agent and must be
// that project's lead. In a conversation an Agent uses
// register_standing_assignment instead.
export async function handleStandingAssignmentRequest({ request, response, url, app }) {
  const change = url.pathname.match(CHANGE_PATH);
  const list = url.pathname === LIST_PATH && request.method === 'GET';
  const create = url.pathname === LIST_PATH && request.method === 'POST';
  const ledger = url.pathname === LEDGER_PATH && request.method === 'GET';
  if (!list && !create && !ledger && !(change && request.method === 'POST')) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (refuseRemoteDecision(request, response, 'Standing assignments are read and changed only on this computer')) return true;
  if (!app.standingAssignments) {
    sendJson(response, 503, { error: 'Standing assignments need a local FULI installation' });
    return true;
  }
  const spaceId = app.config.personal.spaceId;
  if (list) {
    sendJson(response, 200, { assignments: app.standingAssignments.list(spaceId) });
    return true;
  }
  if (ledger) {
    const projectId = url.searchParams.get('personalProjectId');
    sendJson(response, 200, projectId
      ? await projectWorkstreamLedger(app, spaceId, requiredString(projectId, 'personalProjectId', ID_LIMIT))
      : await agentWorkstreamLedger(app, spaceId, requiredString(url.searchParams.get('agentId'), 'agentId', ID_LIMIT)));
    return true;
  }
  const body = await readJson(request);
  const call = delegatedCall(request);
  if (create) {
    sendJson(response, 200, await openWorkstreamInConsole(app, body, call));
    return true;
  }
  const assignmentId = decodeURIComponent(change[1]);
  const expectedRevision = positiveInteger(body.expectedRevision, 'expectedRevision', Number.MAX_SAFE_INTEGER);
  if (change[2] === 'merge') {
    sendJson(response, 200, await mergeWorkstreamsInConsole(app, assignmentId, { ...body, expectedRevision,
      targetRevision: positiveInteger(body.targetRevision, 'targetRevision', Number.MAX_SAFE_INTEGER) }, call));
    return true;
  }
  if (change[2] === 'split') {
    sendJson(response, 200, await splitWorkstreamInConsole(app, assignmentId, { ...body, expectedRevision }, call));
    return true;
  }
  sendJson(response, 200, await correctStandingAssignmentInConsole(app, { ...body, assignmentId,
    action: CORRECTIONS[change[2]], expectedRevision }, call));
  return true;
}
