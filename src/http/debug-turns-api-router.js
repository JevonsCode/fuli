import { refuseRemoteDecision } from './request-policy.js';
import { readJson, sendJson } from './response.js';

// The Debug page, held open from the settings button: the #fulidebug turn records (src/debug-turns/).
// They hold whole conversations of this computer's sessions, so only a
// request from this computer lists, reads or deletes one. An FLA deletes one
// for the person only through run_delegated_action (interface-catalog.js).
const LIST_PATH = '/api/debug-turns';
const DELETE_PATH = '/api/debug-turns/delete';
const MAX_IDS = 50;
const RECORD_PATH = /^\/api\/debug-turns\/([^/]+)$/;

export async function handleDebugTurnsRequest({ request, response, url, debugTurns }) {
  const many = url.pathname === DELETE_PATH;
  const record = many ? null : RECORD_PATH.exec(url.pathname);
  if (url.pathname !== LIST_PATH && !record && !many) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (refuseRemoteDecision(request, response, 'Debug turn records are read only on this computer')) return true;
  if (!debugTurns) {
    sendJson(response, 503, { error: 'Debug turn records need a local FULI installation', code: 'debug_turns_unavailable' });
    return true;
  }
  const allowed = many ? ['POST'] : record ? ['GET', 'DELETE'] : ['GET'];
  if (!allowed.includes(request.method)) {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  if (many) {
    const { ids } = await readJson(request);
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_IDS || !ids.every((id) => typeof id === 'string')) {
      sendJson(response, 400, { error: `ids must list 1 to ${MAX_IDS} records`, code: 'validation' });
      return true;
    }
    sendJson(response, 200, { deleted: debugTurns.removeMany(ids) });
    return true;
  }
  if (!record) {
    sendJson(response, 200, { records: debugTurns.list() });
    return true;
  }
  const id = record[1];
  const found = request.method === 'GET' ? debugTurns.read(id) : debugTurns.remove(id);
  if (!found) sendJson(response, 404, { error: 'No debug turn record has this id', code: 'debug_turn_not_found' });
  else sendJson(response, 200, request.method === 'GET' ? found : { deleted: id });
  return true;
}
