import { recentNotices } from '../notices/recent-notices.js';
import { refuseRemoteDecision } from './request-policy.js';
import { sendJson } from './response.js';

// The workbench's recent notices (src/notices/recent-notices.js). Read only and
// only on this computer: it names projects, FLAs and what was done for the person.
const PATH = '/api/notices';

export async function handleNoticesRequest({ request, response, url, app, delegation = null, system = null }) {
  if (url.pathname !== PATH) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (refuseRemoteDecision(request, response, 'Notices are read only on this computer')) return true;
  if (request.method !== 'GET') { sendJson(response, 405, { error: 'Method not allowed' }); return true; }
  sendJson(response, 200, await recentNotices({ app, delegation, system }));
  return true;
}
