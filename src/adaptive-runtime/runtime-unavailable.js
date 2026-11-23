import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';
import { consoleAutostartNotice } from '../local-runtime/console-autostart-record.js';

// What an Agent sees when FULI's own console cannot be reached for a call's
// runtime lease (rec#39): a controlled runtime_unavailable error instead of
// internal_error, so the call, not FULI's code, is known to have failed
// before anything ran. The text is fixed wording plus one of four reasons;
// it never carries the console's address, a port, a path or an error message.
// It says what did not happen (no task, token or receipt), and one bounded
// next step: where FULI starts its console again by itself, one retry; where
// it will not (stopped on purpose, gave up, a data format waits), tell the
// person once and do not retry.
export const RUNTIME_UNAVAILABLE_REASONS = Object.freeze({
  refused: 'refused the connection',
  unreachable: 'could not be reached',
  timeout: 'did not answer in time',
  not_started: 'is not running'
});
const NOTHING_RAN = 'nothing ran: no task, token or receipt';
const RETRY = 'It restarts by itself: retry once in a few seconds, then tell the person. Never reuse an old token.';
const TELL_PERSON = 'Tell the person once to start FULI (`fuli start`); do not retry. Never reuse an old token.';
// Error codes of a connection that did not complete, as undici reports them in a cause.
const UNREACHABLE_CODES = new Set(['ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);

export function runtimeUnavailableError(reason, { dataDir = null } = {}) {
  const phrase = RUNTIME_UNAVAILABLE_REASONS[reason] ?? RUNTIME_UNAVAILABLE_REASONS.unreachable;
  let held = false;
  try { held = Boolean(dataDir && consoleAutostartNotice(dataDir)); } catch { held = false; }
  const next = held ? TELL_PERSON : RETRY;
  return new ApplicationError(ApplicationErrorCode.RUNTIME_UNAVAILABLE,
    `FULI's console ${phrase}; ${NOTHING_RAN}. ${next}`, { status: 503 });
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
