// Why one wake did not answer, kept on the computer where it ran.
//
// A failed wake keeps its outward code (wake_failed, wake_timeout,
// client_unavailable, ...), which the ladder and older peers read, and adds a
// detail from this closed set. The client's own output stays local: it is kept
// only as a redacted, bounded summary in the roundtable store, and never
// crosses to another computer; only the detail code and the attempt count do.

const WAKE_FAILURE_DETAILS = Object.freeze([
  'client_not_found', // no command for the client, or the OS could not find it
  'spawn_error', // the OS refused to start it
  'login_required', // the client said it is not logged in
  'client_exit_nonzero', // it exited with a non-zero code or a signal
  'no_final_answer', // it exited 0 without a complete final answer
  'output_too_large', // it wrote more than a wake may read
  'timed_out', // it did not answer within the wake's time
  'cancelled', // the asker or the owner stopped it
  'restricted_mode_unsupported' // a constrained run's client is too old for restricted mode (never run without it)
]);

// The summary of a client's output that may be kept: already redacted, then bounded.
const SUMMARY_CHARS = 600;
const OUTWARD = /^([a-z_]{1,64})(?:;detail=([a-z_]{1,32}))?(?:;attempts=([1-9]))?$/;
// A bare code as older peers and coordinators send it. Anything else another computer put in
// the error text is not shown to the asking Agent.
const BARE_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

// A failure error the wake throws. output: the captured tails, never sent anywhere.
export function wakeFailure(code, detail, message, { exitCode = null, signal = null, output = null } = {}) {
  return Object.assign(new Error(message), { code, detail, exitCode, signal, output });
}

// The record kept for one wake attempt. redact: the host's redaction of text
// that leaves the process; without one, the client's output is dropped and
// only the codes, exit code and signal are kept.
export function wakeAttemptRecord({ client, sessionId, error = null, durationMs, redact = null }) {
  const detail = WAKE_FAILURE_DETAILS.includes(error?.detail) ? error.detail : null;
  let summary = null;
  if (error && redact) {
    try { summary = summaryOf([error.output?.stderr, error.output?.stdout], redact); } catch { summary = null; }
  }
  return { client, sessionMode: sessionId ? 'resumed' : 'new', outcome: error ? 'failed' : 'answered',
    code: error ? error.code ?? 'wake_failed' : null, detail,
    exitCode: Number.isSafeInteger(error?.exitCode) ? error.exitCode : null,
    signal: typeof error?.signal === 'string' && /^SIG[A-Z0-9]{1,12}$/.test(error.signal) ? error.signal : null,
    durationMs: Math.max(0, Math.round(durationMs)), outputSummary: summary };
}

// The end of each captured part, stderr first: a client's own error is its last lines.
// Each part is redacted whole before it is cut, so a cut never splits what redaction would remove.
function summaryOf(parts, redact) {
  const kept = [];
  let room = SUMMARY_CHARS;
  for (const part of parts) {
    if (!part || room <= 0) continue;
    const text = String(redact(part)).slice(-room);
    kept.push(text);
    room -= text.length + 1;
  }
  return kept.join('\n') || null;
}

// What a paired device reports for an ask it could not answer: the code, the
// detail code and how many wakes it tried, in the one error string every
// coordinator already relays (an older asker shows it as it is).
export function outwardFailure({ code, detail = null, attempts = null }) {
  return `${code ?? 'wake_failed'}${WAKE_FAILURE_DETAILS.includes(detail) ? `;detail=${detail}` : ''}`
    + `${Number.isSafeInteger(attempts) && attempts > 0 && attempts < 10 ? `;attempts=${attempts}` : ''}`;
}

// The asker's reading of that string: an unknown detail is dropped, a bare
// code an older peer sent stays the reason as it is, and free text reads as
// remote_error.
export function outwardFailureView(error) {
  const [, reason, detail, attempts] = OUTWARD.exec(error) ?? [null, BARE_CODE.test(error) ? error : 'remote_error'];
  return { reason, ...(WAKE_FAILURE_DETAILS.includes(detail) ? { detail } : {}),
    ...(attempts ? { attempts: Number(attempts) } : {}) };
}
