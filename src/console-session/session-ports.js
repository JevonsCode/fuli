import { ApplicationError } from '../app/application-error.js';

const CONSOLE_SESSION_REQUIRED = 'console_session_required';

function consoleSessionRequired() {
  return new ApplicationError(CONSOLE_SESSION_REQUIRED,
    'This needs the console session that fuli open starts on the computer running FULI.', { status: 401 });
}

// What the console session protects (rec#11 D-61): whatever returns full
// history or private content, or changes where data goes, beyond what an
// Agent reaches with its own token and tools. A request without both of this
// launch's credentials gets 401 console_session_required before anything is
// sent, read or written. Two forms, one rule:
//
// sessionBoundPorts: the console's ports that read or change knowledge as the
// person on the human-review channel: the full reads (src/knowledge-owner-reads,
// which also confirms the owner proof of Tonborg's records and the built-in
// Agents' suggestion log), a permanent delete, where knowledge applies, tag
// changes and reads across projects, and the undo of Tonborg's review. Without
// a session each port keeps its shape but every call refuses, and a route
// without its port still answers as before (503).
export function sessionBoundPorts(ports, signedIn) {
  if (signedIn) return ports;
  return Object.fromEntries(Object.entries(ports).map(([name, port]) => [name, port ? refusingPort(port) : port]));
}

// requireConsoleSession: a route that reads or writes through the
// application under the owner's authority instead of a port: the owner's
// inspection of Agent conversations and their policy, an Agent's private
// working memory and its export, confirmed data-format migrations and their
// undo, and a built-in Agent's model settings and trust switch (which decide
// where its model calls, and so the content in them, go).
export function requireConsoleSession(signedIn) {
  if (signedIn !== true) throw consoleSessionRequired();
}

function refusingPort(port) {
  return Object.fromEntries(Object.entries(port).map(([name, value]) => [name,
    typeof value === 'function' ? async () => { throw consoleSessionRequired(); }
      : value && typeof value === 'object' ? refusingPort(value) : value]));
}
