import { sendJson } from './response.js';
import { nonEmptyText, positiveInteger } from '../validation/values.js';

const SCORE_CARD_PATH = /^\/api\/project-agents\/([^/]+)\/score-card(\/evidence)?$/;
const MAX_EVIDENCE_LIMIT = 200;

// Reads of Bole's zero-token score card for the local console; nothing is written.
export async function handleAgentScoreCardRequest({ request, response, url, app }) {
  const match = url.pathname.match(SCORE_CARD_PATH);
  if (!match || request.method !== 'GET') return false;
  const scope = {
    personalSpaceId: url.searchParams.get('personalSpaceId'),
    agentId: decodeURIComponent(match[1]),
    personalProjectId: nonEmptyText(url.searchParams.get('personalProjectId'))
  };
  if (!match[2]) {
    sendJson(response, 200, await app.getAgentScoreCard(scope));
    return true;
  }
  const limit = url.searchParams.get('limit');
  sendJson(response, 200, await app.listAgentScoreEvidence({
    ...scope,
    dimension: url.searchParams.get('dimension'),
    executorId: nonEmptyText(url.searchParams.get('executorId')),
    ...(limit === null ? {} : { limit: positiveInteger(Number(limit), 'limit', MAX_EVIDENCE_LIMIT) })
  }));
  return true;
}
