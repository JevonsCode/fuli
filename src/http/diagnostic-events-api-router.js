import { DELEGATION_HEADER } from '../agent-delegation/delegation-header.js';
import { diagnosticEventsAnswer } from '../diagnostics/query.js';
import { refuseRemoteDecision } from './request-policy.js';
import { sendJson } from './response.js';

// FULI's runtime failures (rec#73, src/diagnostics/): the same read as the
// read_diagnostic_events Agent tool and `fuli diagnostics`. They name this
// computer's operations, so only a request from this computer reads them.
const EVENTS_PATH = '/api/diagnostics/events';
const REPORT_PATH = '/api/diagnostics/issue-report';
const FILTERS = ['from', 'to', 'component', 'level', 'code', 'limit', 'cursor'];

export async function handleDiagnosticEventsRequest({ request, response, url, diagnosticEvents, readIssueReport }) {
  if (url.pathname !== EVENTS_PATH && url.pathname !== REPORT_PATH) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  if (refuseRemoteDecision(request, response, 'FULI\'s diagnostic events are read only on this computer', { directHost: true })) return true;
  if (url.pathname === REPORT_PATH && request.headers?.[DELEGATION_HEADER] !== undefined) {
    sendJson(response, 403, { error: 'Open the local host console to read the Issue report.', code: 'local_user_only' });
    return true;
  }
  if (url.pathname === REPORT_PATH && readIssueReport) {
    sendJson(response, 200, { markdown: await readIssueReport(url.searchParams.get('locale')) });
    return true;
  }
  if (!diagnosticEvents || url.pathname === REPORT_PATH) {
    sendJson(response, 503, { error: 'Diagnostic events need a local FULI installation', code: 'diagnostics_unavailable' });
    return true;
  }
  const input = Object.fromEntries(FILTERS.filter((name) => url.searchParams.has(name))
    .map((name) => [name, url.searchParams.get(name)]));
  sendJson(response, 200, diagnosticEventsAnswer(diagnosticEvents, input));
  return true;
}
