import { sendJson } from './response.js';
import { readKnowledgeItem, readTurnReceiptItems } from '../graphiti/knowledge-item-edit.js';
import { readSessionMigration } from '../graphiti/session-knowledge-migration.js';
import { assertJsonObject } from '../validation/values.js';

const ITEM_PATH = /^\/api\/knowledge\/(entity|relationship)\/([^/]+)$/;

// The console's reads behind a turn receipt's links (rec#20): one knowledge
// item, a turn's full receipt and what a session holds for a batch migration.
// Content edits and deactivation use the existing item PATCH with the version
// the page read; tags use the tag vocabulary routes; scope writes are the
// person's own (knowledge-scope-api-router.js).
// ownerReads: the console's human-review port. The item view, a turn's full
// list and a session's held items show every FLA's items, so they are read
// only through it.
export async function handleKnowledgeItemRequest({ request, response, url, app, ownerReads = null }) {
  if (request.method !== 'GET') return false;
  if (url.pathname === '/api/knowledge/turn-receipt') {
    if (!ownerReads) return ownerReadsUnavailable(response);
    sendJson(response, 200, await readTurnReceiptItems(app, ownerReads, {
      personalSpaceId: url.searchParams.get('personalSpaceId'),
      episodeIds: (url.searchParams.get('episodes') ?? '').split(',').filter(Boolean) }));
    return true;
  }
  if (url.pathname === '/api/knowledge/session-migration') {
    if (!ownerReads) return ownerReadsUnavailable(response);
    response.setHeader('Cache-Control', 'no-store');
    sendJson(response, 200, await readSessionMigration(app, ownerReads, {
      personalSpaceId: url.searchParams.get('personalSpaceId'), sourceApplication: url.searchParams.get('client'),
      sessionId: url.searchParams.get('sessionId'), projectId: url.searchParams.get('projectId'),
      offset: url.searchParams.get('offset') }));
    return true;
  }
  const match = url.pathname.match(ITEM_PATH);
  if (!match) return false;
  if (!ownerReads) return ownerReadsUnavailable(response);
  const queryTags = url.searchParams.has('query_tags') ? JSON.parse(url.searchParams.get('query_tags')) : undefined;
  if (queryTags !== undefined) assertJsonObject(queryTags, 'query_tags');
  sendJson(response, 200, await readKnowledgeItem(app, ownerReads, { itemKind: match[1], itemId: decodeURIComponent(match[2]),
    personalSpaceId: url.searchParams.get('personalSpaceId'), ...(queryTags === undefined ? {} : { queryTags }) }));
  return true;
}

// Without a local installation's human-review channel there is no full read;
// the console's knowledge pages answer this instead of a partial view.
export function ownerReadsUnavailable(response) {
  sendJson(response, 503, { error: 'Reading knowledge in full needs a local FULI installation' });
  return true;
}
