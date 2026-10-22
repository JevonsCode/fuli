import { readJson, sendJson } from './response.js';
import { refuseRemoteDecision } from './request-policy.js';
import { changeKnowledgeScope } from '../graphiti/knowledge-item-edit.js';
import { applySessionMigration } from '../graphiti/session-knowledge-migration.js';

const SCOPE_PATH = /^\/api\/knowledge\/(entity|relationship)\/([^/]+)\/scope$/;
const MIGRATION_PATH = '/api/knowledge/session-migration';

// Where knowledge applies, changed by the person (rec#20, rec#11 D-22): one
// item's quick edit and a session's batch migration. Accepted only on this
// computer, and sent on the human-review channel (src/knowledge-scope), so an
// Agent can link to the page but never post the change, not even straight to
// the Provider with its own token. No Agent tool reaches these routes.
export async function handleKnowledgeScopeRequest({ request, response, url, app, scopeConsole }) {
  const item = url.pathname.match(SCOPE_PATH);
  if (request.method !== 'POST' || (!item && url.pathname !== MIGRATION_PATH)) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (refuseRemoteDecision(request, response, 'Where knowledge applies is changed only on this computer')) return true;
  if (!scopeConsole) {
    sendJson(response, 503, { error: 'Changing where knowledge applies needs a local FULI installation' });
    return true;
  }
  const body = await readJson(request);
  sendJson(response, 200, item
    ? await changeKnowledgeScope(app, scopeConsole, { ...body, itemKind: item[1], itemId: decodeURIComponent(item[2]) })
    : await applySessionMigration(app, scopeConsole, body));
  return true;
}
