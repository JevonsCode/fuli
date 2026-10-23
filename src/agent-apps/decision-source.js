// Where a management decision (approve, rollback, disable, delete) came in, and
// what FULI verified about who made it. Normal Agent tools (MCP and fuli_call)
// expose none of these decisions, so they arrive through the CLI or the local
// HTTP console. An interactive terminal, a loopback address, a repeated digest
// or a one-time token can be used by any process running as the same OS
// account, and a CSRF token only stops cross-site web forgery: none of them
// shows that a person decided, so such a decision records presence unverified.
//
// Only `fuli app approve` and `fuli app rollback` add a presence check
// (src/agent-apps/verified-decisions.js): the trusted CLI starts an OS user
// verification (Windows Hello) and binds that one successful result to this
// decision's challenge. Hello returns the user verification result; it does not
// sign the challenge. An Agent's shell can start the command too, but the Hello
// dialog needs the local user's interaction, and it is not on the secure
// desktop, so it does not stop UI automation by a process of the same account.
export const DECISION_ENTRYPOINTS = Object.freeze(['cli', 'http']);
export const PRESENCE_LEVELS = Object.freeze(['unverified', 'hello', 'touchid', 'polkit']);
// What a successful presence check verified: the current OS user, through the OS.
export const OS_USER_VERIFIED = 'os_user_verified';

// The presence check of a decision that had none.
export const UNVERIFIED_CHECK = Object.freeze({
  presence: PRESENCE_LEVELS[0], verification: null, challengeId: null, verifiedAt: null
});

export function decisionSource(actor) {
  if (!DECISION_ENTRYPOINTS.includes(actor?.entrypoint)) {
    throw new TypeError(`An Agent app decision comes through ${DECISION_ENTRYPOINTS.join(' or ')}`);
  }
  return { entrypoint: actor.entrypoint, presence: UNVERIFIED_CHECK.presence };
}
