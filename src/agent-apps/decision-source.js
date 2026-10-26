// Where a management decision (approve, rollback, disable, delete) came in, and
// what FULI checked about it. Normal Agent tools (MCP and fuli_call) expose
// none of these decisions, so they arrive through the CLI or the local HTTP
// console. An interactive terminal, a loopback address, a repeated digest, a
// typed app name or a one-time token can be used by any process running as the
// same OS account, and a CSRF token only stops cross-site web forgery: none of
// them shows that a person decided.
//
// Only `fuli app approve` and `fuli app rollback` complete the terminal
// confirmation flow (src/agent-apps/confirmed-decisions.js): the CLI shows the
// app name, a summary of its terms and the trusted-mode warning, and the app
// name typed back commits that one challenge. This does not prove a person did
// it and does not protect against other programs of the same account (rec#11
// D-36.9). On Windows, `--hello` adds Windows Hello on top, recorded as
// presence hello; it is never required.
export const DECISION_ENTRYPOINTS = Object.freeze(['cli', 'http']);
export const PRESENCE_LEVELS = Object.freeze(['unverified', 'hello', 'touchid', 'polkit']);
// What an approval the run gate accepts went through.
export const TERMINAL_CONFIRMATION = 'terminal_confirmation';

// The confirmation of a decision that had none (the console's).
export const UNVERIFIED_CHECK = Object.freeze({
  presence: PRESENCE_LEVELS[0], verification: null, challengeId: null, verifiedAt: null, trustMode: null, termsVersion: null
});

export function decisionSource(actor) {
  if (!DECISION_ENTRYPOINTS.includes(actor?.entrypoint)) {
    throw new TypeError(`An Agent app decision comes through ${DECISION_ENTRYPOINTS.join(' or ')}`);
  }
  return { entrypoint: actor.entrypoint, presence: UNVERIFIED_CHECK.presence };
}
