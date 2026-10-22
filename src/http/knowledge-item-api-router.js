import { readJson, sendJson } from './response.js';
import { isLoopbackAddress } from './request-policy.js';
import { changeKnowledgeScope, readKnowledgeItem, readTurnReceiptItems } from '../graphiti/knowledge-item-edit.js';
import { applySessionMigration, readSessionMigration } from '../graphiti/session-knowledge-migration.js';

const ITEM_PATH = /^\/api\/knowledge\/(entity|relationship)\/([^/]+)(\/scope)?$/;
const MIGRATION_PATH = '/api/knowledge/session-migration';

// The console's quick edit of one knowledge item, a turn's full receipt and a
// session's batch migration into a formal project (rec#20). Content edits and
// deactivation use the existing item PATCH with the version the page read;
// tags use the tag vocabulary routes. A migration is confirmed only by the
// person on this computer: an Agent can link to the page, never post it.
export async function handleKnowledgeItemRequest({ request, response, url, app }) {
  if (url.pathname === '/api/knowledge/turn-receipt' && request.method === 'GET') {
    sendJson(response, 200, await readTurnReceiptItems(app, {
      personalSpaceId: url.searchParams.get('personalSpaceId'),
      episodeIds: (url.searchParams.get('episodes') ?? '').split(',').filter(Boolean) }));
    return true;
  }
  if (url.pathname === MIGRATION_PATH) return handleSessionMigration({ request, response, url, app });
  const match = url.pathname.match(ITEM_PATH);
  if (!match) return false;
  const item = { itemKind: match[1], itemId: decodeURIComponent(match[2]) };
  if (!match[3] && request.method === 'GET') {
    sendJson(response, 200, await readKnowledgeItem(app, { ...item,
      personalSpaceId: url.searchParams.get('personalSpaceId') }));
    return true;
  }
  if (match[3] && request.method === 'POST') {
    sendJson(response, 200, await changeKnowledgeScope(app, { ...(await readJson(request)), ...item }));
    return true;
  }
  return false;
}

async function handleSessionMigration({ request, response, url, app }) {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method === 'GET') {
    sendJson(response, 200, await readSessionMigration(app, {
      personalSpaceId: url.searchParams.get('personalSpaceId'), sourceApplication: url.searchParams.get('client'),
      sessionId: url.searchParams.get('sessionId'), projectId: url.searchParams.get('projectId') }));
    return true;
  }
  if (request.method !== 'POST') return false;
  if (!isLoopbackAddress(request.socket?.remoteAddress)) {
    sendJson(response, 403, { error: 'A session\'s knowledge is migrated only on this computer', code: 'local_user_only' });
    return true;
  }
  sendJson(response, 200, await applySessionMigration(app, await readJson(request)));
  return true;
}
