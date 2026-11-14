import { isLocalOwnerRequest } from '../../packages/roundtable/src/peer/control.js';
import { readJson, sendJson } from '../http/response.js';
import { withoutControls } from '../text/control-characters.js';

// The owner's console for visit requests (seconding C) and requester modes.
// Every route answers only this computer's loopback address with a loopback
// Host, like the LAN roundtable controls. The interface catalog keeps approve,
// keep, discard and mode changes local_user_only (an injected request must
// never approve itself through an Agent); decline and cancel only lower risk
// and are delegable. The requester's text is untrusted: it is returned as
// text for the console to show without controls, never as markup.
const LIST_PATH = '/api/visit-requests';
const REQUEST_PATH = /^\/api\/visit-requests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/;
const DECISION_PATH = /^\/api\/visit-requests\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/(approve|decline|keep|discard|cancel)$/;
const MODE_PATH = /^\/api\/visitor-access\/requesters\/([^/]+)\/mode$/;
const STATUS = Object.freeze({ request_not_found: 404, state_conflict: 409, requester_invalid: 400, mode_unknown: 400,
  mode_not_allowed: 400, visitor_access_unavailable: 503 });

export async function handleVisitRequestsApiRequest({ request, response, url, visitorAccess }) {
  const { pathname } = url;
  const decision = DECISION_PATH.exec(pathname);
  const one = REQUEST_PATH.exec(pathname);
  const mode = MODE_PATH.exec(pathname);
  if (pathname !== LIST_PATH && !decision && !one && !mode) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (!isLocalOwnerRequest(request)) {
    sendJson(response, 403, { error: 'local_owner_only', message: 'Visit requests are decided only on this computer' });
    return true;
  }
  const expected = decision ? 'POST' : mode ? 'PUT' : 'GET';
  if (request.method !== expected) {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  if (!visitorAccess?.requests) {
    sendJson(response, 503, { error: 'Visit requests need a local FULI installation', code: 'requests_unavailable' });
    return true;
  }
  const requests = visitorAccess.requests;
  if (mode) return answer(response, setMode(visitorAccess, decodedKey(mode[1]), await readJson(request)), (changed) => ({
    requester: changed.requester, effects: changed.effects }));
  if (decision) {
    const [, id, action] = decision;
    const body = await readJson(request);
    const moved = action === 'decline' ? await requests.decline(id, { reason: body.reason ?? null })
      : await requests[action](id);
    return answer(response, moved, (done) => ({ request: listItem(done.request), ...(done.warning ? { warning: done.warning } : {}) }));
  }
  if (one) {
    const card = await requests.card(one[1]);
    return answer(response, card, (found) => ({ request: { ...listItem(found.request), what: shown(found.request.what),
      requesterAreas: found.request.requesterAreas.map(shown), baseCommit: found.request.baseCommit,
      worktreePath: found.request.worktreePath, planningMs: found.request.planningMs, runMs: found.request.runMs,
      events: found.events, diff: found.diff } }));
  }
  const listed = requests.list({ state: url.searchParams.get('state') || null,
    limit: Number(url.searchParams.get('limit') ?? 50) });
  sendJson(response, 200, { requests: listed.requests.map(listItem),
    awaiting: { count: listed.awaiting.count, newest: listed.awaiting.newest.map(listItem) } });
  return true;
}

// A paired device's mode: trusted (完全信任) sets the marker the store
// requires; any other mode clears it. The label is the one the console shows
// for that requester; an existing requester keeps its own when none is sent.
function setMode(visitorAccess, key, body) {
  if (!key) return { ok: false, code: 'requester_invalid' };
  return visitorAccess.setRequesterMode({ key, kind: key.startsWith('peer:') ? 'peer' : 'guest', label: body.label,
    mode: body.mode, ownDevice: body.mode === 'trusted' });
}

function answer(response, result, view) {
  if (result.ok) sendJson(response, 200, view(result));
  else sendJson(response, STATUS[result.code] ?? 400, { error: result.code, code: result.code });
  return true;
}

function decodedKey(segment) {
  try { return decodeURIComponent(segment); } catch { return null; }
}

const shown = (text) => (typeof text === 'string' ? withoutControls(text) : text);

// One request as the console lists it: who asked, what (title), the lead's
// assessment and the risk it implies, how it was decided and what came of it.
function listItem(request) {
  return { id: request.id, state: request.state, review: request.review, holdReason: request.holdReason, heldPaths: request.heldPaths,
    requester: { key: request.requesterKey, label: request.requesterLabel, agentName: request.agentName, source: request.source },
    projectId: request.projectId, agentId: request.agentId, title: shown(request.title), plan: request.plan,
    planError: request.planError, risk: riskOf(request.plan), modeAtReceipt: request.modeAtReceipt,
    modeAtDecision: request.modeAtDecision, decidedBy: request.decidedBy, reason: request.reason, error: request.error,
    result: request.files || request.summary ? { summary: request.summary, branch: request.branch, files: request.files,
      diffstat: request.diffstat } : null,
    createdAt: request.createdAt, updatedAt: request.updatedAt };
}

// The lead's assessment as a badge: high when it touches dependencies,
// configuration or the network or is large, medium when it names risks or is
// medium-sized, low otherwise; null without an assessment.
function riskOf(plan) {
  if (!plan) return null;
  const flags = [plan.dependencyChanges && 'dependencies', plan.configChanges && 'config', plan.network && 'network',
    plan.size === 'l' && 'large'].filter(Boolean);
  return { level: flags.length ? 'high' : plan.size === 'm' || plan.risks.length ? 'medium' : 'low', flags };
}
