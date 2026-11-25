import { DELEGATION_HEADER } from '../agent-delegation/delegation-header.js';
import { refuseRemoteDecision } from './request-policy.js';
import { readJson, sendJson } from './response.js';

// Runners of this computer (docs/runner.md), managed only here: an invitation
// gives another computer full read and write access to the person's FULI, so
// inviting is the person's own decision (local_user_only in the interface
// catalog); listing and revoking only show or lower that access.
const INVITATIONS_PATH = '/api/runners/invitations';
const RUNNERS_PATH = '/api/runners';
const GRANTS_PATH = /^\/api\/runners\/([0-9a-f]{64})\/grants$/;
const RUNNER_PATH = /^\/api\/runners\/([0-9a-f]{8,64})$/;

export async function handleRunnersRequest({ request, response, url, runnerHost }) {
  const runner = RUNNER_PATH.exec(url.pathname);
  const grants = GRANTS_PATH.exec(url.pathname);
  if (url.pathname !== INVITATIONS_PATH && url.pathname !== RUNNERS_PATH && !runner && !grants) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (refuseRemoteDecision(request, response, 'Runners are managed only on this computer', { directHost: Boolean(grants) || url.pathname === INVITATIONS_PATH })) return true;
  if (grants && request.method !== 'GET' && request.headers[DELEGATION_HEADER] !== undefined) {
    sendJson(response, 403, { error: 'Only the person on the host can change follow permissions', code: 'local_user_only' });
    return true;
  }
  if (!runnerHost) {
    sendJson(response, 503, { error: 'Runners need a local FULI installation', code: 'runners_unavailable' });
    return true;
  }
  if (url.pathname === INVITATIONS_PATH && request.method === 'POST') {
    const body = await readJson(request);
    answer(response, await runnerHost.invite({ name: body?.name, ...(body?.scopes !== undefined ? { scopes: body.scopes } : {}) }), 201);
  } else if (url.pathname === RUNNERS_PATH && request.method === 'GET') {
    answer(response, runnerHost.list());
  } else if (grants && request.method === 'GET') {
    answer(response, runnerHost.grantList(grants[1]));
  } else if (grants && request.method === 'POST') {
    answer(response, await runnerHost.grantDecision(grants[1], await readJson(request)));
  } else if (runner && request.method === 'DELETE') {
    answer(response, await runnerHost.revoke(runner[1]));
  } else {
    sendJson(response, 405, { error: 'Method not allowed' });
  }
  return true;
}

function answer(response, result, status = 200) {
  if (result.ok) {
    const { ok: _ok, ...body } = result;
    sendJson(response, status, body);
  } else {
    const statuses = { runner_unknown: 404, scope_invalid: 400, decision_invalid: 400, scope_not_owned: 409,
      pairing_changed: 409, decision_changed: 409 };
    sendJson(response, statuses[result.code] ?? 503, { error: result.code, code: result.code });
  }
}
