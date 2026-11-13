import { refuseRemoteDecision } from './request-policy.js';
import { sendJson } from './response.js';

// 「最近被问」 in Settings › 局域网圆桌: what visitors from paired computers read
// of this computer's shared projects (who, their Agent, the project, what they
// asked, how many items went back, when). Only from this computer, like the
// LAN roundtable controls: it names the visitors and their questions.
const READS_PATH = '/api/visitor-access/reads';
const DEFAULT_LIMIT = 20;

export async function handleVisitorAccessRequest({ request, response, url, visitorAccess }) {
  if (url.pathname !== READS_PATH) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (refuseRemoteDecision(request, response, 'Visitor reads are shown only on this computer')) return true;
  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  if (!visitorAccess) {
    sendJson(response, 503, { error: 'Visitor reads need a local FULI installation', code: 'visitor_access_unavailable' });
    return true;
  }
  const limit = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
  sendJson(response, 200, { reads: visitorAccess.recentReads({ limit: Number.isSafeInteger(limit) ? limit : DEFAULT_LIMIT })
    .map(read => ({ id: read.id, requester: read.requesterLabel, agentName: read.agentName, projectId: read.projectId,
      queries: read.queries, resultsCount: read.resultsCount, at: read.at })) });
  return true;
}
