import { isLocalOwnerRequest } from '../../packages/roundtable/src/peer/control.js';
import { sendJson } from './response.js';

// What Settings › 局域网圆桌 reads about visitors from paired computers:
// 「最近被问」 (every contact they made with this computer's shared projects:
// who, their Agent, the project, a card or what they searched, the outcome,
// when) and the mode each requester was given (只能问, 计划, 自动, 完全信任). Both
// name the visitors, so they answer under the LAN roundtable controls' own
// guard: this computer's loopback address and a loopback Host.
const READS_PATH = '/api/visitor-access/reads';
const REQUESTERS_PATH = '/api/visitor-access/requesters';
const DEFAULT_LIMIT = 20;

export async function handleVisitorAccessRequest({ request, response, url, visitorAccess }) {
  const read = url.pathname === READS_PATH ? recentReads : url.pathname === REQUESTERS_PATH ? requesterModes : null;
  if (!read) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (!isLocalOwnerRequest(request)) {
    sendJson(response, 403, { error: 'local_owner_only', message: 'Visitor access is shown only on this computer' });
    return true;
  }
  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  if (!visitorAccess) {
    sendJson(response, 503, { error: 'Visitor access needs a local FULI installation', code: 'visitor_access_unavailable' });
    return true;
  }
  const answer = read(visitorAccess, url);
  if (!answer.ok) sendJson(response, 400, { error: answer.code, code: answer.code });
  else sendJson(response, 200, answer.body);
  return true;
}

function recentReads(visitorAccess, url) {
  const limit = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
  const recent = visitorAccess.recentReads({ limit: Number.isSafeInteger(limit) ? limit : DEFAULT_LIMIT });
  if (!recent.ok) return recent;
  return { ok: true, body: { reads: recent.reads.map(read => ({ id: read.id, requester: read.requesterLabel,
    agentName: read.agentName, projectId: read.projectId, action: read.action, outcome: read.outcome, code: read.code,
    queries: read.queries, resultsCount: read.resultsCount, at: read.at })) } };
}

// The requesters the person gave a mode; one not listed is 计划 (plan).
function requesterModes(visitorAccess) {
  const listed = visitorAccess.requesters();
  return listed.ok ? { ok: true, body: { requesters: listed.requesters, defaultMode: listed.defaultMode } } : listed;
}
