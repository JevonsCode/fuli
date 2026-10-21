import { sendJson } from './response.js';

// The console page where the person confirms or cancels a capture change an
// Agent asked for (rec#5 C4-2, rec#11 D-16). The console's own action is the
// confirmation; no Agent tool reaches these routes.
const CHANGE_PATH = /^\/api\/capture-changes\/([A-Za-z0-9_-]{1,64})(?:\/(confirm|cancel))?$/;

export async function handleCaptureChangeRequest({ request, response, url, app }) {
  const match = url.pathname.match(CHANGE_PATH);
  if (!match) return false;
  const [, previewId, action] = match;
  if (request.method === 'GET' && !action) {
    sendJson(response, 200, app.captureChanges.read(previewId));
    return true;
  }
  if (request.method !== 'POST' || !action) return false;
  sendJson(response, 200, action === 'confirm' ? app.captureChanges.confirm(previewId) : app.captureChanges.cancel(previewId));
  return true;
}
