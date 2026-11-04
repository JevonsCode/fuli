import { InvalidInputError } from '../app/application-error.js';
import { createOldDataConsole } from '../old-data/console-actions.js';
import { refuseRemoteDecision } from './request-policy.js';
import { sendJson } from './response.js';

// Settings › 存储 (rec#80 group B): the old data FULI keeps before it changes
// something, with the live and old data sizes (GET), 恢复 (POST …/restore) and
// 立即删除 (POST …/delete). Only from this computer: the list names local
// files, and both actions change them. The person's own AI lists and reads the
// same items with read_old_data and restores through run_delegated_action;
// delete-now stays the person's (interface-catalog.js).
const LIST_PATH = '/api/old-data';
const ACTION_PATH = /^\/api\/old-data\/([^/]+)\/(restore|delete)$/;

// restore: the console's whole-store restore (consoleRestore), or null.
export async function handleOldDataRequest({ request, response, url, shelf, restore }) {
  const action = ACTION_PATH.exec(url.pathname);
  if (url.pathname !== LIST_PATH && !action) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (refuseRemoteDecision(request, response, 'Old data is managed only on this computer')) return true;
  if (!shelf) {
    sendJson(response, 503, { error: 'Old data needs a local FULI installation', code: 'old_data_unavailable' });
    return true;
  }
  if (request.method !== (action ? 'POST' : 'GET')) {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  if (!action) {
    sendJson(response, 200, await shelf.list());
    return true;
  }
  const actions = createOldDataConsole({ shelf, restore });
  const id = oldDataId(action[1]);
  sendJson(response, 200, action[2] === 'restore' ? await actions.restore(id) : await actions.delete(id));
  return true;
}

function oldDataId(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new InvalidInputError('The old data id in the path is not valid; pass an id from GET /api/old-data.');
  }
}
