// What a reply cites through FULI's own source links (source-marker.js), read at
// Stop (rec#88). A task closed by the Stop hook never reported its use, and
// reporting costs the model a turn, so learning had no input: the link the
// reply already carries says the same thing for free. It is the model's own
// citation, so it counts as `cited` and carries the weight of a reported one.
const SOURCE_LINK = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/knowledge\/[^/\s)]+\/[^/\s)]+\/directory\/(entity|relationship)\/([^/\s)?#]+)/g;
const MAX_CITED = 20;

export function citedKnowledge(reply) {
  if (typeof reply !== 'string') return [];
  const cited = new Map();
  for (const [, itemKind, encoded] of reply.matchAll(SOURCE_LINK)) {
    const itemId = decoded(encoded);
    if (itemId) cited.set(`${itemKind}:${itemId}`, { itemId, itemKind, useKind: 'cited' });
  }
  return [...cited.values()].slice(0, MAX_CITED);
}

function decoded(segment) {
  try { return decodeURIComponent(segment); } catch { return null; }
}
