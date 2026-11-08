import { refuseRemoteDecision } from './request-policy.js';
import { readJson, sendJson } from './response.js';

// The npm copies of FULI beside the desktop app (src/desktop/npm-copy-control.js):
// the console's notice reads the list, the person removes a copy or closes its
// notice. Removing one changes the person's own computer, so only a request
// from this computer does it, and an FLA only with the person's words
// (agent_relayed in the interface catalog). Without the desktop app there is
// nothing here.

const LIST_PATH = '/api/system/npm-copies';
const UNINSTALL_PATH = '/api/system/npm-copies/uninstall';
const NOTICE_PATH = '/api/system/npm-copies/notice';

export async function handleNpmCopiesRequest({ request, response, url, system }) {
  if (![LIST_PATH, UNINSTALL_PATH, NOTICE_PATH].includes(url.pathname)) return false;
  response.setHeader('Cache-Control', 'no-store');
  const control = system?.npmCopies ?? null;
  const method = { [LIST_PATH]: 'GET', [UNINSTALL_PATH]: 'POST', [NOTICE_PATH]: 'PUT' }[url.pathname];
  if (request.method !== method) {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  if (method === 'GET') {
    sendJson(response, 200, control ? control.list() : { copies: [] });
    return true;
  }
  if (refuseRemoteDecision(request, response, 'An npm copy of FULI is changed only on this computer')) return true;
  if (!control) {
    sendJson(response, 404, { error: 'Only the desktop app looks after npm copies of FULI', code: 'npm_copies_unavailable' });
    return true;
  }
  const body = await readJson(request);
  sendJson(response, 200, method === 'POST' ? await control.uninstall(body) : control.setNotice(body));
  return true;
}
