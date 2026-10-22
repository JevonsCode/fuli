import { personalHumanReviewChannel, providerRefusal } from '../graphiti/human-review-channel.js';

// A person's change of where knowledge applies, from the local console
// (rec#20, rec#11 D-22): the quick edit of one item and a session's batch
// migration into a formal project. Both are audited as the person's own
// change, so their provider routes take the human-review token this port sends
// (human-review-channel.js); an Agent's access token alone is refused. That
// proves the local console, not a person's presence (same OS account, as in
// D-21). Only the console's loopback routes use this module; no MCP or Agent
// tool module imports it (test/session-knowledge-migration.test.js).

export function knowledgeScopeConsole(dataDir, { send = personalHumanReviewChannel(dataDir) } = {}) {
  const request = async (path, body) => {
    const { ok, status, payload } = await send(path, body, { review: true });
    if (ok) return payload;
    throw providerRefusal(status, payload);
  };
  return {
    changeScope: (itemId, body) => request(`/v1/knowledge/items/${encodeURIComponent(itemId)}/scope`, body),
    applySessionMigration: (body) => request('/v1/knowledge/session-migrations/apply', body)
  };
}
