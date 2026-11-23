import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';
import { consoleAutostartHold } from '../local-runtime/console-autostart-record.js';

// What an Agent sees when FULI's own console cannot be reached for a call's
// runtime lease (rec#39): a controlled runtime_unavailable error instead of
// internal_error, so the call, not FULI's code, is known to have failed
// before anything ran. The text is fixed wording plus one of four reasons;
// it never carries the console's address, a port, a path or an error message.
// It says what did not happen (no task, token or receipt), and one bounded
// next step, chosen by what the automatic start recorded (consoleAutostartHold):
// stopped on purpose or gave up, tell the person once to start FULI and do not
// retry; a data format update that waits asks for its confirmation too. With
// no recorded state (nothing recorded, unreadable, not set up) nothing is
// promised: one bounded retry, then the person.
export const RUNTIME_UNAVAILABLE_REASONS = Object.freeze({
  refused: 'refused the connection',
  unreachable: 'could not be reached',
  timeout: 'did not answer in time',
  not_started: 'is not running'
});
const NOTHING_RAN = 'nothing ran: no task, token or receipt';
const NEVER_REUSE = 'Never reuse an old token.';
// The one step, by what the automatic start recorded (consoleAutostartHold).
const START = 'Tell the person once to start FULI (`fuli start`); do not retry.';
const STEPS = Object.freeze({
  stopped: `${START} ${NEVER_REUSE}`,
  gave_up: `${START} ${NEVER_REUSE}`,
  data_format: `Tell the person once to start FULI and confirm the update in Settings › Data format; do not retry. ${NEVER_REUSE}`,
  unknown: `It may restart by itself: retry once in a few seconds; if it fails again, tell the person to start FULI (\`fuli start\`). ${NEVER_REUSE}`
});
// Error codes of a connection that did not complete, as undici reports them in a cause.
const UNREACHABLE_CODES = new Set(['ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);

export function runtimeUnavailableError(reason, { dataDir = null } = {}) {
  const phrase = RUNTIME_UNAVAILABLE_REASONS[reason] ?? RUNTIME_UNAVAILABLE_REASONS.unreachable;
  let hold = null;
  try { hold = dataDir ? consoleAutostartHold(dataDir) : null; } catch { hold = null; }
  return new ApplicationError(ApplicationErrorCode.RUNTIME_UNAVAILABLE,
    `FULI's console ${phrase}; ${NOTHING_RAN}. ${STEPS[hold ?? 'unknown']}`, { status: 503 });
}

// The reason a failed lease request names, or null for an error that is not a
// failure to reach the console (a caller's own abort, a refusal the console
// answered): those stay as they were.
export function unreachableReason(error, { callerAborted = false } = {}) {
  if (callerAborted) return null;
  if (error?.name === 'TimeoutError') return 'timeout';
  if (!(error instanceof TypeError)) return null;
  const causes = [error.cause?.code, ...(Array.isArray(error.cause?.errors) ? error.cause.errors.map(item => item?.code) : [])];
  if (causes.includes('ECONNREFUSED')) return 'refused';
  if (causes.some(code => UNREACHABLE_CODES.has(code)) || error.message === 'fetch failed') return 'unreachable';
  return null;
}
