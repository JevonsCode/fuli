// The source applications FULI tells apart, and which one a stored client
// list covers (rec#11 D-64). OpenCode and Antigravity used the generic `other`
// until each got its own source: a list written before that names `other` for
// it, so at read time a list that contains `other` and lacks `opencode` (or
// `antigravity`) covers that client too. Without it, every Agent hired before
// the client got its own source refuses it, and its tasks have no owner. No
// stored list is rewritten. The graph Provider applies the same rule in
// graph-provider/fuli_graph/client_coverage.py, the console in
// web/src/lib/source-coverage.ts.
export const SOURCE_APPLICATIONS = Object.freeze(['codex', 'claude', 'claude_code', 'cursor', 'kiro', 'opencode', 'antigravity', 'other']);

const LEGACY_ALIASES = Object.freeze({ opencode: 'other', antigravity: 'other' });

// `explicit`: clients the person set themselves beside the list, which the
// alias never decides for (the capture policy's capturedSources).
export function coversClient(clients, client, { explicit = [] } = {}) {
  const listed = Array.isArray(clients) ? clients : [];
  if (listed.includes(client)) return true;
  const legacy = LEGACY_ALIASES[client];
  return Boolean(legacy) && listed.includes(legacy) && !explicit.includes(client);
}
