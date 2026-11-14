import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isControlledError } from '../app/application-error.js';
import { FULI_VERSION } from '../package-metadata.js';
import { shareableText } from '../text/shareable-text.js';
import { singleLine } from '../text/single-line.js';
import { utf8Preview } from '../text/utf8-preview.js';

// What one diagnostic event may say (rec#73). Every field is either a fixed
// identifier or text passed through safeText, so no credential, task token,
// URL query value, prompt or knowledge text reaches the log. Writers pass a
// short reason they chose (or a controlled error's message, written for the
// caller and never repeating a value); never a raw exception message.

export const DIAGNOSTIC_EVENT_VERSION = 1;
export const DIAGNOSTIC_COMPONENTS = Object.freeze(['hook', 'http', 'provider', 'mcp', 'roundtable']);
export const DIAGNOSTIC_LEVELS = Object.freeze(['error', 'warning']);
// failed: FULI could not do it. refused: FULI answered the caller with an error it can act on.
const LEVEL_OF_OUTCOME = Object.freeze({ failed: 'error', refused: 'warning' });

const SAFE_CODE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPERATION_BYTES = 120;
const REASON_BYTES = 240;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

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

// A failure record's reason. An error no caller handled (an Agent saw only
// internal_error) keeps its message out, like failureReason, but names its
// class, its cause's code and the first frame of FULI's own code that raised
// it, relative to the install: enough to find the bug from the record alone
// (rec#137), with no value the call carried.
export function recordedFailureReason(error, fallback) {
  if (isControlledError(error)) return failureReason(error, fallback);
  const name = [error?.name].find(value => typeof value === 'string' && SAFE_CODE.test(value)) ?? 'unknown';
  const cause = errorCode(error?.cause);
  const site = failureSite(error);
  return `${fallback} (${name}${cause ? `, cause ${cause}` : ''}${site ? ` at ${site}` : ''})`;
}

const INSTALL_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OWN_CODE = /^(src|packages)\//;
const STACK_FRAME = /^\s*at (?:.*\()?(.+?):(\d+):\d+\)?$/;

// `src/…/module.js:LINE` of the innermost stack frame in FULI's own code, or null.
function failureSite(error) {
  const stack = typeof error?.stack === 'string' ? error.stack : '';
  for (const line of stack.split('\n').slice(1)) {
    const frame = STACK_FRAME.exec(line);
    if (!frame) continue;
    let file = frame[1];
    try { if (file.startsWith('file://')) file = fileURLToPath(file); } catch { continue; }
    if (!isAbsolute(file)) continue;
    const own = relative(INSTALL_ROOT, file).split(sep).join('/');
    if (OWN_CODE.test(own) && !own.includes('node_modules/')) return `${own}:${frame[2]}`;
  }
  return null;
}

// Text kept for an Agent to read: one line, URL credentials dropped and query
// values masked, local paths, secrets and long opaque values replaced.
function safeText(value, limit = REASON_BYTES) {
  // An operation names the console's own routes (POST /api/…), which are no local paths.
  return utf8Preview(shareableText(singleLine(value), { mode: 'keep-routes' }), limit);
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
