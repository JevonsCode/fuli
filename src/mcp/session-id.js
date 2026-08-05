import { randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKFLOW_OBSERVATION_TOOL = 'record_workflow_transition_observation';

const SESSION_ID_TOOLS = new Set([
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
  clock = () => new Date()
) {
  if (name === WORKFLOW_OBSERVATION_TOOL) {
    if (!hostSessionId) {
      throw new TypeError('Workflow observations require an MCP host session');
    }
    const {
      sessionId: _sessionId,
      idempotencyKey: _idempotencyKey,
      observedAt: _observedAt,
      hostSessionId: _hostSessionId,
      hostObservedAt: _hostObservedAt,
      ...safeInput
    } = input ?? {};
    return {
      ...safeInput,
      hostSessionId,
      hostObservedAt: clock().toISOString()
    };
  }
  if (!nativeThreadId || !SESSION_ID_TOOLS.has(name)) return input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  if (typeof input.sessionId !== 'string' || input.sessionId.trim() === nativeThreadId) {
    return input;
  }
  return { ...input, sessionId: nativeThreadId };
}
