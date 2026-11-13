import { isLocalOwnerRequest } from '../../packages/roundtable/src/peer/control.js';
import { sendJson } from './response.js';

// 「最近被问」 in Settings › 局域网圆桌: every contact visitors from paired
// computers made with this computer's shared projects (who, their Agent, the
// project, a card or what they searched, the outcome, when). It names the
// visitors and their questions, so it answers under the LAN roundtable
// controls' own guard: this computer's loopback address and a loopback Host.
const READS_PATH = '/api/visitor-access/reads';
const DEFAULT_LIMIT = 20;

export async function handleVisitorAccessRequest({ request, response, url, visitorAccess }) {
  if (url.pathname !== READS_PATH) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (!isLocalOwnerRequest(request)) {
    sendJson(response, 403, { error: 'local_owner_only', message: 'Visitor reads are shown only on this computer' });
    return true;
  }
  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  if (!visitorAccess) {
    sendJson(response, 503, { error: 'Visitor reads need a local FULI installation', code: 'visitor_access_unavailable' });
    return true;
  }
  const limit = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
  const recent = visitorAccess.recentReads({ limit: Number.isSafeInteger(limit) ? limit : DEFAULT_LIMIT });
  if (!recent.ok) {
    sendJson(response, 400, { error: recent.code, code: recent.code });
    return true;
  }
  sendJson(response, 200, { reads: recent.reads.map(read => ({ id: read.id, requester: read.requesterLabel,
    agentName: read.agentName, projectId: read.projectId, action: read.action, outcome: read.outcome, code: read.code,
    queries: read.queries, resultsCount: read.resultsCount, at: read.at })) });
  return true;
}
