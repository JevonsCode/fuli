import { desktopGlance } from '../desktop-glance/glance.js';
import { refuseRemoteDecision } from './request-policy.js';
import { sendJson } from './response.js';

// The few rows the desktop client's tray menu shows (src/desktop-glance/glance.js).
// Read only and only on this computer: it names assistants and what they work on.
const PATH = '/api/desktop/glance';

export async function handleDesktopGlanceRequest({ request, response, url, app }) {
  if (url.pathname !== PATH) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (refuseRemoteDecision(request, response, 'The desktop glance is read only on this computer')) return true;
  if (request.method !== 'GET') { sendJson(response, 405, { error: 'Method not allowed' }); return true; }
  sendJson(response, 200, await desktopGlance({ app }));
  return true;
}
