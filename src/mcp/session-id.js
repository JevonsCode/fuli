import { randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKFLOW_OBSERVATION_TOOL = 'record_workflow_transition_observation';
const PROJECT_AGENT_SOURCE_TOOLS = new Set([
  'call_employee_tool',
  'begin_task_context',
  'verify_task_checkpoint',
  'checkpoint_task_knowledge',
  'get_collaboration_preferences',
  'capture_session_knowledge',
  'record_decision_trace',
  'create_project_agent_assignment',
  'replace_project_agent_assignment',
  'coordinate_project_agent_task',
  'submit_project_agent_task',
  'get_project_agent_context',
  'get_project_agent_memory',
  'checkpoint_project_agent_memory',
  'record_project_agent_task_activity',
  'preflight_executor',
  'report_executor_health',
  'record_project_agent_executor_actual'
]);

const SESSION_ID_TOOLS = new Set([
  'get_collaboration_preferences',
  'begin_task_context',
  'verify_task_checkpoint',
  'capture_session_knowledge',
  'record_decision_trace',
  'record_knowledge_usage',
  'record_knowledge_feedback'
]);

export function nativeCodexThreadId(env = process.env) {
  const value = typeof env?.CODEX_THREAD_ID === 'string'
    ? env.CODEX_THREAD_ID.trim()
    : '';
  return UUID.test(value) ? value : null;
}

export function mcpHostSessionId(
  env = process.env,
  idFactory = randomUUID
) {
  return nativeCodexThreadId(env) ?? `fuli-host-${idFactory()}`;
}

export function normalizeAgentSessionInput(
  name,
  input,
  nativeThreadId,
  hostSessionId = nativeThreadId,
  clock = () => new Date(),
  sourceApplication = nativeThreadId ? 'codex' : 'other'
) {
  if (name === WORKFLOW_OBSERVATION_TOOL) {
    if (!hostSessionId) {
      throw new TypeError('Workflow observations require an MCP host session');
    }
    const {
      sessionId: _sessionId,
      session_id: _session_id,
      idempotencyKey: _idempotencyKey,
      idempotency_key: _idempotency_key,
      observedAt: _observedAt,
      observed_at: _observed_at,
      hostSessionId: _hostSessionId,
      host_session_id: _host_session_id,
      hostObservedAt: _hostObservedAt,
      host_observed_at: _host_observed_at,
      sourceApplication: _sourceApplication,
      source_application: _source_application,
      sourceSessionId: _sourceSessionId,
      source_session_id: _source_session_id,
      sourceSessionVerified: _sourceSessionVerified,
      source_session_verified: _source_session_verified,
      ...safeInput
    } = input ?? {};
    return {
      ...safeInput,
      sourceApplication: normalizeMcpSourceApplication(sourceApplication),
      hostSessionId,
      hostObservedAt: clock().toISOString()
    };
  }
  if (PROJECT_AGENT_SOURCE_TOOLS.has(name)) {
    if (!hostSessionId) {
      throw new TypeError('Project Agent calls require an MCP host session');
    }
    const safeSourceApplication = normalizeMcpSourceApplication(sourceApplication);
    const {
      sourceApplication: _sourceApplication,
      source_application: _source_application,
      sourceSessionId: _sourceSessionId,
      source_session_id: _source_session_id,
      sourceSessionVerified: _sourceSessionVerified,
      source_session_verified: _source_session_verified,
      ...safeInput
    } = input ?? {};
    return {
      ...safeInput,
      ...(SESSION_ID_TOOLS.has(name) && nativeThreadId ? { sessionId: nativeThreadId } : {}),
      sourceApplication: safeSourceApplication,
      sourceSessionId: hostSessionId,
      ...(name === 'call_employee_tool' ? { sourceSessionVerified: Boolean(nativeThreadId && nativeThreadId === hostSessionId) } : {}),
    };
  }
  if (!nativeThreadId || !SESSION_ID_TOOLS.has(name)) return input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  if (typeof input.sessionId !== 'string' || input.sessionId === nativeThreadId) {
    return input;
  }
  return { ...input, sessionId: nativeThreadId };
}

export function normalizeMcpSourceApplication(value) {
  if (!['codex', 'claude', 'claude_code', 'cursor', 'kiro', 'other'].includes(value)) {
    throw new TypeError('Unsupported MCP source application');
  }
  return value;
}
