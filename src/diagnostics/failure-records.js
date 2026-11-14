import { isControlledError } from '../app/application-error.js';
import { errorCode, failureReason, recordedFailureReason } from './safe-event.js';

// The diagnostics events of the console's HTTP API and of MCP tool calls
// (rec#73), recorded after the caller already has its answer. A missing log
// (an application without a data directory) records nothing.

const SERVER_ERROR = 500;

// status: the HTTP status the request was answered with.
export function recordHttpFailure(log, { request, error, status, startedAt }) {
  return recorded(log, () => ({
    component: 'http',
    operation: `${request.method} ${pathOf(request.url)}`,
    outcome: status >= SERVER_ERROR ? 'failed' : 'refused',
    code: errorCode(error) ?? `http_${status}`,
    reason: `HTTP ${status}: ${failureReason(error, 'internal error')}`,
    durationMs: Date.now() - startedAt
  }));
}

// sessionId: the client session the call came from, when its host named one.
export function recordToolFailure(log, { toolName, error, sessionId = null, startedAt }) {
  return recorded(log, () => ({
    component: 'mcp',
    operation: toolName,
    outcome: !isControlledError(error) || error.status >= SERVER_ERROR ? 'failed' : 'refused',
    code: isControlledError(error) ? errorCode(error) : 'internal_error',
    reason: recordedFailureReason(error, 'Tool execution failed'),
    durationMs: Date.now() - startedAt,
    correlationId: sessionId
  }));
}

// A roundtable wake that did not answer (packages/roundtable wake-failure.js):
// codes, exit code and signal only. The client's output stays, redacted, in
// the roundtable store of this computer.
export function recordWakeFailure(log, { client, sessionMode, code, detail = null, exitCode = null, signal = null,
  durationMs = null, remote = false }) {
  return recorded(log, () => ({
    component: 'roundtable',
    operation: `wake ${client} ${sessionMode}`,
    outcome: 'failed',
    code: detail ?? code,
    reason: `${remote ? 'A paired device\'s ask' : 'An ask'} could not wake ${client} in a ${sessionMode} session: ${code}`
      + `${detail ? ` (${detail})` : ''}${exitCode === null ? '' : `, exit code ${exitCode}`}${signal ? `, signal ${signal}` : ''}`,
    durationMs
  }));
}

// Never throws: the caller's answer is already decided.
function recorded(log, fields) {
  try { return log ? log.record(fields()) : false; } catch { return false; }
}

// The path alone: a query string may carry a search, an ID or a token.
function pathOf(url) {
  try { return new URL(url ?? '/', 'http://127.0.0.1').pathname; } catch { return 'unparsable'; }
}
