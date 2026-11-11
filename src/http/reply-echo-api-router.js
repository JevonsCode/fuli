import { relayedDecision } from '../agent-delegation/delegation-header.js';
import { InvalidInputError } from '../app/application-error.js';
import { dropReplyEchoes, findReplyEchoes, restoreReplyEchoes } from '../graphiti/reply-echo-group.js';
import { ownerReadsUnavailable } from './knowledge-item-api-router.js';
import { readJson, sendJson } from './response.js';

// 「之前误存的 Agent 回复」 in 待决策 (graphiti/reply-echo-group.js): the console
// reads which pending items are earlier Agent replies, and the person drops
// them together or takes the drop back. An FLA lists them with
// list_reply_echoes; dropping and restoring are the person's, which an FLA
// relays only in their words (agent_relayed in the interface catalog).
// ownerReads: the console's full read; without it there is no group.

const LIST_PATH = '/api/knowledge/reply-echoes';
const DROP_PATH = '/api/knowledge/reply-echoes/drop';
const RESTORE_PATH = '/api/knowledge/reply-echoes/restore';

export async function handleReplyEchoRequest({ request, response, url, app, ownerReads = null }) {
  const method = { [LIST_PATH]: 'GET', [DROP_PATH]: 'POST', [RESTORE_PATH]: 'POST' }[url.pathname];
  if (!method) return false;
  if (request.method !== method) {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  response.setHeader('Cache-Control', 'no-store');
  if (url.pathname === RESTORE_PATH) {
    const body = await readJson(request);
    sendJson(response, 200, await restoreReplyEchoes(app, { personalSpaceId: space(app, body.personalSpaceId), items: body.items },
      relayedDecision(request), ownerReads));
    return true;
  }
  if (!ownerReads) return ownerReadsUnavailable(response);
  if (method === 'GET') {
    const personalSpaceId = space(app, url.searchParams.get('personalSpaceId'));
    const echoes = await findReplyEchoes(pageReader(ownerReads, personalSpaceId));
    sendJson(response, 200, { total: echoes.length, items: echoes.map(({ itemKind, itemId, signals }) => ({ itemKind, itemId, signals })) });
    return true;
  }
  const body = await readJson(request);
  const personalSpaceId = space(app, body.personalSpaceId);
  sendJson(response, 200, await dropReplyEchoes(app, pageReader(ownerReads, personalSpaceId),
    { personalSpaceId, items: body.items }, relayedDecision(request), ownerReads));
  return true;
}

const pageReader = (ownerReads, spaceId) => (limit, offset) => ownerReads.graph({ spaceId, limit, personalProjectId: null, offset });

function space(app, personalSpaceId) {
  if (!personalSpaceId || personalSpaceId !== app.config?.personal?.spaceId) {
    throw new InvalidInputError('personalSpaceId must be the active personal space');
  }
  return personalSpaceId;
}
