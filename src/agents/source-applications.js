// The source applications FULI tells apart, and which one a stored client
// list covers (rec#11 D-64). OpenCode used the generic `other` until it got
// its own `opencode`: a list written before that names `other` for it, so at
// read time a list that contains `other` and lacks `opencode` covers
// `opencode` too. No stored list is rewritten. The graph Provider applies the
// same rule in graph-provider/fuli_graph/client_coverage.py.
export const SOURCE_APPLICATIONS = Object.freeze(['codex', 'claude', 'claude_code', 'cursor', 'kiro', 'opencode', 'other']);

const LEGACY_ALIASES = Object.freeze({ opencode: 'other' });

export function coversClient(clients, client) {
  const listed = Array.isArray(clients) ? clients : [];
  if (listed.includes(client)) return true;
  const legacy = LEGACY_ALIASES[client];
  return Boolean(legacy) && listed.includes(legacy);
}
