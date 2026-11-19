import { GRAPH_TOOL_DEFINITIONS } from '../agent-tools/graph-definitions.js';
import { ROUNDTABLE_TOOL_NAMES } from '../agent-roundtable/tools.js';
import { SOURCE_APPLICATIONS } from '../agents/source-applications.js';
import { ApplicationErrorCode } from '../app/application-error.js';
import { providerFailureCode, providerOperation } from './provider-operation.js';
import { DIAGNOSTIC_COMPONENTS, DIAGNOSTIC_LEVELS } from './safe-event.js';

// An Issue is public. Project the stored event onto product vocabulary again:
// old local logs can carry a free-text reason, a session ID or a dynamic URL.
const TOOLS = new Set([...GRAPH_TOOL_DEFINITIONS.map(({ name }) => name), ...ROUNDTABLE_TOOL_NAMES,
  'fuli_call', 'list_agent_interfaces', 'get_collaboration_preferences']);
const ROUTES = new Set(('health system diagnostics debug-turns graph knowledge spaces search settings projects ' +
  'personal-projects project-agents agents runtime capture roundtable reviews lifecycle notices models').split(' '));
const CODES = new Set([...Object.values(ApplicationErrorCode), 'internal_error', 'Error', 'TypeError', 'SyntaxError',
  'ENOENT', 'EACCES', 'EPERM', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'ENOSPC',
  'provider_error', 'provider_not_ready', 'provider_incompatible', 'provider_exited', 'native_start_failed',
  'mcp_start_failed', 'mcp_runtime_config_invalid', 'mcp_config_unreadable', 'mcp_config_outdated', 'mcp_config_removed',
  'mcp_detection_unavailable', 'mcp_target_missing', 'mcp_config_missing', 'mcp_inspector_unavailable',
  'mcp_inspector_timeout', 'mcp_inspector_invalid_response', 'client_not_found', 'spawn_error', 'login_required',
  'client_exit_nonzero', 'no_final_answer', 'output_too_large', 'timed_out', 'knowledge_recovery_pending']);
const HOOKS = new Set(['SessionStart', 'UserPromptSubmit', 'Stop', 'PreToolUse', 'PostToolUse', 'SessionEnd',
  'sessionStart', 'sessionEnd', 'beforeSubmitPrompt', 'afterAgentResponse', 'stop']);

export const publicVersion = value => typeof value === 'string' && /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-(?:dev|alpha|beta|rc)\.\d{1,5})?$/.test(value) ? value : 'unknown';
export const publicSource = value => SOURCE_APPLICATIONS.includes(value) ? value : 'other';

function operation(component, value) {
  if (typeof value !== 'string') return 'unknown';
  if (component === 'mcp') {
    if (TOOLS.has(value)) return value;
    const [stage, source] = value.split('.');
    if (stage === 'configuration' && source === 'scan') return 'configuration.scan';
    return ['configuration', 'start'].includes(stage) ? `${stage}.${publicSource(source)}` : 'tool';
  }
  if (component === 'provider') {
    if (value === 'native.start') return value;
    const [method, family] = value.split(' ');
    return providerOperation(method, family ?? '');
  }
  if (component === 'http') {
    const match = /^(GET|POST|PUT|PATCH|DELETE) \/api\/([a-z-]+)(?:[/?#]|$)/.exec(value);
    return match ? `${match[1]} /api/${ROUTES.has(match[2]) ? match[2] : 'other'}` : 'console request';
  }
  if (component === 'hook') {
    const [source, hook] = value.split('.');
    return `${publicSource(source)}.${HOOKS.has(hook) ? hook : 'hook'}`;
  }
  if (component === 'roundtable') return `wake ${publicSource(value.split(' ')[1])}`;
  return 'unknown';
}

export function issueEventLine(event) {
  const component = DIAGNOSTIC_COMPONENTS.includes(event.component) ? event.component : 'unknown';
  const level = DIAGNOSTIC_LEVELS.includes(event.level) ? event.level : 'unknown';
  const knownCode = CODES.has(event.code) || providerFailureCode(event.code) !== 'provider_error' || /^http_[45]\d\d$/.test(event.code);
  const parts = [new Date(event.at).toISOString(), level, component, operation(component, event.operation),
    knownCode ? event.code : 'unclassified'];
  // Earlier HTTP events stored the returned status at the start of the reason.
  const status = event.httpStatus ?? (component === 'http' ? Number(/^HTTP ([45]\d\d)\b/.exec(event.reason)?.[1]) : null);
  if (Number.isInteger(status) && status >= 400 && status <= 599) parts.push(`HTTP ${status}`);
  if (Number.isSafeInteger(event.durationMs) && event.durationMs >= 0) parts.push(`${event.durationMs} ms`);
  parts.push(`FULI ${publicVersion(event.version)}`);
  return parts.join(' | ');
}
