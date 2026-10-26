import { parseHardDeleteInput } from '../knowledge-hard-delete/input.js';

import { refuseRemoteDecision } from './request-policy.js';
import { readJson, sendJson } from './response.js';

// The console's 「彻底删除」 of one knowledge item (rec#5 C9): a preview of
// exactly what goes, then the person's confirmation bound to that preview.
// Both are accepted only on loopback and only for the active personal space;
// the provider also requires the human-review channel the port sends. The
// status route settles a delete whose answer was lost and finishes its local
// cleanup; it never sends the delete again. No
// Agent tool reaches these routes; an Agent can only suggest the person opens
// the item's page (the interface catalog marks them local_user_only).

const PATH = /^\/api\/knowledge\/(entity|relationship|episode|session)\/([^/]+)\/hard-delete(?:\/(preview|status))?$/;

export async function handleKnowledgeHardDeleteRequest({ request, response, url, app, hardDelete }) {
  const match = url.pathname.match(PATH);
  if (!match) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  if (refuseRemoteDecision(request, response, 'Knowledge is permanently deleted only on this computer')) return true;
  if (!hardDelete) {
    sendJson(response, 503, { error: 'Permanent deletion needs a local FULI installation' });
    return true;
  }
  const action = match[3] ?? 'confirm';
  const input = parseHardDeleteInput({ action, itemKind: match[1], itemId: decodeURIComponent(match[2]),
    body: await readJson(request), personalSpaceId: app.config?.personal?.spaceId });
  sendJson(response, 200, await hardDelete[action](input));
  return true;
}
