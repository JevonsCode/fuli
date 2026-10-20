// Where a management decision (approve, rollback, disable, delete) came in, and
// what FULI verified about who made it. Normal Agent tools (MCP and fuli_call)
// expose none of these decisions, so they arrive through the CLI or the local
// HTTP console. That is all FULI knows: an interactive terminal, a loopback
// address, a repeated digest or a one-time token can be used by any process
// running as the same OS account, and a CSRF token only stops cross-site web
// forgery. None of them shows that a person decided. A user-presence check
// (Windows Hello, Touch ID, polkit) arrives with the app runner; until then
// every decision records presence as unverified.
export const DECISION_ENTRYPOINTS = Object.freeze(['cli', 'http']);
export const PRESENCE_LEVELS = Object.freeze(['unverified', 'hello', 'touchid', 'polkit']);

// No presence check exists yet, so this is the only level FULI writes.
const UNVERIFIED = PRESENCE_LEVELS[0];

export function decisionSource(actor) {
  if (!DECISION_ENTRYPOINTS.includes(actor?.entrypoint)) {
    throw new TypeError(`An Agent app decision comes through ${DECISION_ENTRYPOINTS.join(' or ')}`);
  }
  return { entrypoint: actor.entrypoint, presence: UNVERIFIED };
}
