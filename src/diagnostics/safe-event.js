import { randomUUID } from 'node:crypto';

import { isControlledError } from '../app/application-error.js';
import { FULI_VERSION } from '../package-metadata.js';
import { redactSensitiveContent } from '../security/sensitive-content.js';
import { withoutLocalPaths } from '../text/local-paths.js';
import { singleLine } from '../text/single-line.js';
import { utf8Preview } from '../text/utf8-preview.js';

// What one diagnostic event may say (rec#73). Every field is either a fixed
// identifier or text passed through safeText, so no credential, task token,
// URL query value, prompt or knowledge text reaches the log. Writers pass a
// short reason they chose (or a controlled error's message, written for the
// caller and never repeating a value); never a raw exception message.

export const DIAGNOSTIC_EVENT_VERSION = 1;
export const DIAGNOSTIC_COMPONENTS = Object.freeze(['hook', 'http', 'provider', 'mcp']);
export const DIAGNOSTIC_LEVELS = Object.freeze(['error', 'warning']);
// failed: FULI could not do it. refused: FULI answered the caller with an error it can act on.
const LEVEL_OF_OUTCOME = Object.freeze({ failed: 'error', refused: 'warning' });

const SAFE_CODE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPERATION_BYTES = 120;
const REASON_BYTES = 240;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

const URL_WITH_PARTS = /\b([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/@]*@)?([^\s?#]*)(\?[^\s#]*)?(#\S*)?/gi;
// A long opaque value (task token, session secret, signed id) with no name before it.
const OPAQUE_VALUE = /\b[A-Za-z0-9_-]{32,}\b/g;

// An error's code or class when it is a fixed identifier; null otherwise.
export function errorCode(error) {
  return [error?.code, error?.name].find(value => typeof value === 'string' && SAFE_CODE.test(value)) ?? null;
}

// What a failed request or call may say of its error: a controlled error's
// message, written for the caller without the values it was given; otherwise
// the fallback, since another error's message may carry a path, a prompt or a secret.
export function failureReason(error, fallback) {
  return isControlledError(error) && typeof error.message === 'string' ? error.message : fallback;
}

// Text kept for an Agent to read: one line, URL credentials dropped and query
// values masked, local paths, secrets and long opaque values replaced.
function safeText(value, limit = REASON_BYTES) {
  const text = singleLine(value)
    .replace(URL_WITH_PARTS, (_url, scheme, rest, query = '') =>
      `${scheme}${rest}${query && `?${query.slice(1).split('&').map(pair => `${pair.split('=')[0]}=…`).join('&')}`}`);
  return utf8Preview(redactSensitiveContent(withoutLocalPaths(text)).replace(OPAQUE_VALUE, '[redacted:opaque]'), limit);
}

// One event as it is stored. component, outcome and operation are required;
// a field that is not safe as given is left out rather than stored.
export function diagnosticEvent({ component, operation, outcome, code = null, reason = null, durationMs = null,
  correlationId = null }, { now = new Date() } = {}) {
  if (!DIAGNOSTIC_COMPONENTS.includes(component)) throw new TypeError('Unknown diagnostic component');
  if (!Object.hasOwn(LEVEL_OF_OUTCOME, outcome)) throw new TypeError('Unknown diagnostic outcome');
  return {
    v: DIAGNOSTIC_EVENT_VERSION,
    id: randomUUID(),
    at: zonedTime(now),
    component,
    version: FULI_VERSION,
    operation: safeText(operation, OPERATION_BYTES),
    outcome,
    level: LEVEL_OF_OUTCOME[outcome],
    code: typeof code === 'string' && SAFE_CODE.test(code) ? code : null,
    reason: reason === null ? null : safeText(reason),
    ...(Number.isSafeInteger(durationMs) && durationMs >= 0 && durationMs <= MAX_DURATION_MS ? { durationMs } : {}),
    ...(typeof correlationId === 'string' && SAFE_ID.test(correlationId) ? { correlationId } : {})
  };
}

// ISO 8601 with this computer's offset (2026-11-05T14:03:00.120+08:00).
function zonedTime(date) {
  const offset = -date.getTimezoneOffset();
  const local = new Date(date.getTime() + offset * 60_000).toISOString().slice(0, -1);
  const sign = offset < 0 ? '-' : '+';
  const minutes = Math.abs(offset);
  return `${local}${sign}${String(Math.trunc(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
