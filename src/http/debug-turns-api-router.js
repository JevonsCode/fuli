import { refuseRemoteDecision } from './request-policy.js';
import { sendJson } from './response.js';

// Settings › 系统 › 调试记录: the #debug turn records (src/debug-turns/).
// They hold whole conversations of this computer's sessions, so only a
// request from this computer lists, reads or deletes one. An FLA deletes one
// for the person only through run_delegated_action (interface-catalog.js).
const LIST_PATH = '/api/debug-turns';
const RECORD_PATH = /^\/api\/debug-turns\/([^/]+)$/;

export async function handleDebugTurnsRequest({ request, response, url, debugTurns }) {
  const record = RECORD_PATH.exec(url.pathname);
  if (url.pathname !== LIST_PATH && !record) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (refuseRemoteDecision(request, response, 'Debug turn records are read only on this computer')) return true;
  if (!debugTurns) {
    sendJson(response, 503, { error: 'Debug turn records need a local FULI installation', code: 'debug_turns_unavailable' });
    return true;
  }
  const allowed = record ? ['GET', 'DELETE'] : ['GET'];
  if (!allowed.includes(request.method)) {
    sendJson(response, 405, { error: 'Method not allowed' });
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
