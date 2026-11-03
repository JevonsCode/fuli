import { refuseRemoteDecision } from './request-policy.js';
import { readJson, sendJson } from './response.js';

const POLICY_PATH = '/api/agent-delegation';
const CATEGORY_PATH = /^\/api\/agent-delegation\/categories\/([a-z_]+)$/;

// Settings › AI permissions (rec#11 D-81): each category with its switch and
// the latest changes FLAs made for the person; a switch is the person's own
// change on this computer (the interface catalog marks it local_user_only,
// so the delegation gate refuses an FLA's request for it).
export async function handleAgentDelegationRequest({ request, response, url, delegation }) {
  const category = url.pathname.match(CATEGORY_PATH);
  const read = url.pathname === POLICY_PATH && request.method === 'GET';
  if (!read && !(category && request.method === 'PUT')) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (!delegation) {
    sendJson(response, 503, { error: 'AI permissions need a local FULI installation', code: 'delegation_unavailable' });
    return true;
  }
  if (read) {
    sendJson(response, 200, delegation.read());
    return true;
  }
  if (refuseRemoteDecision(request, response, 'AI permissions are changed only on this computer')) return true;
  const { enabled } = await readJson(request);
  sendJson(response, 200, delegation.setCategory(category[1], enabled));
  return true;
}
