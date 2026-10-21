import { readJson, sendJson } from './response.js';
import { changeKnowledgeScope, readKnowledgeItem, readTurnReceiptItems } from '../graphiti/knowledge-item-edit.js';

const ITEM_PATH = /^\/api\/knowledge\/(entity|relationship)\/([^/]+)(\/scope)?$/;

// The console's quick edit of one knowledge item and a turn's full receipt
// (rec#20). Content edits and deactivation use the existing item PATCH with
// the version the page read; tags use the tag vocabulary routes.
export async function handleKnowledgeItemRequest({ request, response, url, app }) {
  if (url.pathname === '/api/knowledge/turn-receipt' && request.method === 'GET') {
    sendJson(response, 200, await readTurnReceiptItems(app, {
      personalSpaceId: url.searchParams.get('personalSpaceId'),
      episodeIds: (url.searchParams.get('episodes') ?? '').split(',').filter(Boolean) }));
    return true;
  }
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
