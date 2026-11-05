import { semanticIndexStatus } from '../semantic/scheduler.js';
import { refuseRemoteDecision } from './request-policy.js';
import { sendJson } from './response.js';

// The meaning index on the console (rec#88): GET says how far it is filled for
// the connected model; POST starts a pass now (after a person connects or
// changes the model). Only from this computer: a pass sends knowledge to the
// person's own model.
const STATUS_PATH = '/api/semantic/status';
const FILL_PATH = '/api/semantic/fill';

export async function handleSemanticRequest({ request, response, url, app, indexer }) {
  if (url.pathname !== STATUS_PATH && url.pathname !== FILL_PATH) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (url.pathname === STATUS_PATH) {
    if (request.method !== 'GET') { sendJson(response, 405, { error: 'Method not allowed' }); return true; }
    sendJson(response, 200, await semanticIndexStatus(app, indexer));
    return true;
  }
  if (refuseRemoteDecision(request, response, 'The meaning index fills only on this computer')) return true;
  if (request.method !== 'POST') { sendJson(response, 405, { error: 'Method not allowed' }); return true; }
  if (!indexer) { sendJson(response, 503, { error: 'The meaning index needs a local FULI installation', code: 'semantic_unavailable' }); return true; }
  void indexer.runNow();
  sendJson(response, 202, await semanticIndexStatus(app, indexer));
  return true;
}
