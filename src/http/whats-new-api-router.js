import { readJson, sendJson } from './response.js';

// What is new in the installed FULI version (src/whats-new/whats-new.js): the
// console's one-time notice and any Agent read the same answer; the console
// marks the notice seen once it has shown it.

const STATUS_PATH = '/api/system/whats-new';
const SEEN_PATH = '/api/system/whats-new/seen';

export async function handleWhatsNewRequest({ request, response, url, system }) {
  if (url.pathname !== STATUS_PATH && url.pathname !== SEEN_PATH) return false;
  const whatsNew = system?.whatsNew ?? null;
  response.setHeader('Cache-Control', 'no-store');
  const method = url.pathname === STATUS_PATH ? 'GET' : 'PUT';
  if (request.method !== method) {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  if (!whatsNew) {
    sendJson(response, 404, { error: 'What is new is not available here', code: 'whats_new_unavailable' });
    return true;
  }
  if (method === 'GET') {
    sendJson(response, 200, whatsNew.status());
    return true;
  }
  try {
    sendJson(response, 200, whatsNew.markSeen(await readJson(request)));
  } catch (error) {
    if (error.code !== 'not_installed_version') throw error;
    sendJson(response, 400, { error: error.message, code: error.code });
  }
  return true;
}
