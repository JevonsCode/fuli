import { ApplicationError } from '../app/application-error.js';

const CONSOLE_SESSION_REQUIRED = 'console_session_required';

function consoleSessionRequired() {
  return new ApplicationError(CONSOLE_SESSION_REQUIRED,
    'This needs the console session that fuli open starts. Run fuli open in a terminal on this computer.', { status: 401 });
}

// The console's ports that read or change knowledge as the person on the
// human-review channel (rec#11 D-61): the full reads (src/knowledge-owner-reads,
// which also confirms the owner proof of Tonborg's records and the built-in
// Agents' suggestion log), a permanent delete, where knowledge applies, tag
// changes and reads across projects, and the undo of Tonborg's review. The
// server attaches the human-review proof itself, so it sends on that channel
// only for a request of the console session. Without one each port is kept
// in shape, but every call refuses with 401 console_session_required before
// anything is sent, read or written, and a route without its port still
// answers as before (503).
export function sessionBoundPorts(ports, signedIn) {
  if (signedIn) return ports;
  return Object.fromEntries(Object.entries(ports).map(([name, port]) => [name, port ? refusingPort(port) : port]));
}

function refusingPort(port) {
  return Object.fromEntries(Object.entries(port).map(([name, value]) => [name,
    typeof value === 'function' ? async () => { throw consoleSessionRequired(); }
      : value && typeof value === 'object' ? refusingPort(value) : value]));
}
