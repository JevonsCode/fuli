// Only published route families enter diagnostics. Everything after the family
// can contain a project, space, account or search term, even on a failed request.
const FAMILIES = new Set((
  'health healthz auth spaces workspaces knowledge search knowledge-tags retrieval semantic builtin-embeddings ' +
  'agent-attention agent-conversations agent-loans agent-verification collaboration-preferences conversation-triage ' +
  'executor-routing-rules executors occupation-demand occupations personal-global-preference-candidates ' +
  'personal-projects preference-conflicts project-agent-assignments project-agent-context project-agent-coordination-policy ' +
  'project-agent-dismissal-lessons project-agent-executor-actuals project-agent-pages project-agent-recruitments ' +
  'project-agent-routing-learning project-agent-routing-outcomes project-agent-score-card project-agent-task-blockers ' +
  'project-agent-task-events project-agent-task-pages project-agent-tasks project-agent-worker-runs project-agents ' +
  'project-memory-usage session-records subscriptions task-context-agents task-context-sessions task-contexts ' +
  'temporary-projects workflow-candidates data-format session-migrations'
).split(' '));

export function providerOperation(method, path) {
  const family = path.replace(/^\/(?:v1\/)?/, '').split(/[/?#]/, 1)[0];
  const verb = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? method : 'request';
  return `${verb} ${FAMILIES.has(family) ? family : 'other'}`;
}

const PROVIDER_CODES = new Set(['provider_unavailable', 'provider_timeout', 'provider_invalid_response', 'provider_http_5xx',
  'data_format_read_only', 'data_format_blocked', 'data_format_changed_underneath', 'data_format_locked',
  'data_format_stale_preview', 'data_format_nothing_to_undo', 'data_format_undo_blocked']);

// A refusal code can come from the other server, just like its free-text message.
export const providerFailureCode = code => PROVIDER_CODES.has(code) ? code : 'provider_error';

export function recordProviderFailure(log, method, path, { status, code }, started) {
  log?.record({ component: 'provider', operation: providerOperation(method, path), code: providerFailureCode(code),
    httpStatus: code === 'provider_timeout' ? null : status, durationMs: Date.now() - started,
    outcome: status >= 400 && status < 500 ? 'refused' : 'failed' });
}
