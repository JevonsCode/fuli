import { personalHumanReviewChannel, providerRefusal } from '../graphiti/human-review-channel.js';
import { graphReadPath } from '../graphiti/knowledge-reader.js';

// The person's own full reads of personal knowledge, from the local console:
// the graph, one item's view, a turn's full receipt and a session's records.
// Knowledge an FLA wrote, and a preference given to one FLA, is that FLA's;
// the provider shows it to any other reader only with the human-review token
// this port sends (human-review-channel.js). Without it the provider reads as
// an Agent and hides it; a wrong token is refused. That proves the local
// console, not a person's presence (same OS account, as in D-21). Only the
// console's loopback routes use this module; no MCP or Agent tool module
// imports it (test/knowledge-owner-reads.test.js).

export function knowledgeOwnerReads(dataDir, { send = personalHumanReviewChannel(dataDir) } = {}) {
  const request = async (path, body, method = 'POST') => {
    const { ok, status, payload } = await send(path, body, { review: true, method });
    if (ok) return payload;
    throw providerRefusal(status, payload);
  };
  return {
    graph: ({ spaceId, limit, personalProjectId, offset }) =>
      request(graphReadPath(spaceId, { limit, personalProjectId, offset }), null, 'GET'),
    itemView: (body) => request('/v1/knowledge/item-views', body),
    turnReceipt: (body) => request('/v1/knowledge/turn-receipts', body),
    sessionRecords: (body) => request('/v1/session-records', body)
  };
}
