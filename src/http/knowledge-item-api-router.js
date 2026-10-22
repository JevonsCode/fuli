import { sendJson } from './response.js';
import { readKnowledgeItem, readTurnReceiptItems } from '../graphiti/knowledge-item-edit.js';
import { readSessionMigration } from '../graphiti/session-knowledge-migration.js';

const ITEM_PATH = /^\/api\/knowledge\/(entity|relationship)\/([^/]+)$/;

// The console's reads behind a turn receipt's links (rec#20): one knowledge
// item, a turn's full receipt and what a session holds for a batch migration.
// Content edits and deactivation use the existing item PATCH with the version
// the page read; tags use the tag vocabulary routes; scope writes are the
// person's own (knowledge-scope-api-router.js).
export async function handleKnowledgeItemRequest({ request, response, url, app }) {
  if (request.method !== 'GET') return false;
  if (url.pathname === '/api/knowledge/turn-receipt') {
    sendJson(response, 200, await readTurnReceiptItems(app, {
      personalSpaceId: url.searchParams.get('personalSpaceId'),
      episodeIds: (url.searchParams.get('episodes') ?? '').split(',').filter(Boolean) }));
    return true;
  }
  if (url.pathname === '/api/knowledge/session-migration') {
    response.setHeader('Cache-Control', 'no-store');
    sendJson(response, 200, await readSessionMigration(app, {
      personalSpaceId: url.searchParams.get('personalSpaceId'), sourceApplication: url.searchParams.get('client'),
      sessionId: url.searchParams.get('sessionId'), projectId: url.searchParams.get('projectId'),
      offset: url.searchParams.get('offset') }));
    return true;
  }
  const match = url.pathname.match(ITEM_PATH);
  if (!match) return false;
  sendJson(response, 200, await readKnowledgeItem(app, { itemKind: match[1], itemId: decodeURIComponent(match[2]),
    personalSpaceId: url.searchParams.get('personalSpaceId') }));
  return true;
}
