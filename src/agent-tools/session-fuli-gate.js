import { sessionsMayBeOff, sessionUseDecision } from '../graphiti/session-layer-decision.js';
import { captureNotice } from '../graphiti/capture-notice.js';
import { activeAgentHostClient } from '../app/agent-request-context.js';

// What an Agent may still call for a session FULI is off for (rec#5 C3b).
// Every other tool returns stored memory or preferences to the model (entry,
// recall, searches, Agent memory, conversations, knowledge, reviews, team and
// task history), starts or answers collaboration, or writes, so it is refused:
// the server instructions tell the model to call some of them every turn, and
// a read the model starts is injection all the same. A new tool is refused
// until it is listed here. The person's own reads stay available outside the
// session: the console and `fuli mcp --call` name no stopped session.
// These only report settings or the session's own task lifecycle, cancel
// something already sent, or hold the local runtime.
const OPEN_TOOLS = new Set([
  'get_capture_policy', 'explain_settings', 'list_agent_interfaces', 'get_graphiti_status',
  'update_capture_policy', 'verify_task_checkpoint',
  'cancel_agent_message', 'cancel_agent_attention',
  'acquire_runtime_lease', 'refresh_runtime_lease', 'release_runtime_lease'
]);
export const SESSION_FULI_OFF = 'fuli_off';
// Tools whose own schema names no task: those an Agent calls without a task of
// their own (entry, recall, team and judgment reads) and the records a task
// writes as it goes or closes. They take the current taskContextToken only to
// say which session they are for: without it, a call is refused while any
// session of its client is off, since no host session shows the current one
// (option Y, #251). The token is used here and never reaches the tool.
const ATTRIBUTED_TOOLS = new Set([
  'get_collaboration_preferences', 'get_user_taste_skill', 'search_current_project_knowledge', 'search_knowledge_graph',
  'search_connected_knowledge', 'list_project_agents', 'get_project_agent_context', 'get_project_agent_memory',
  'list_preference_conflicts', 'resolve_deferred_preference_conflict', 'request_agent_attention', 'assess_agent_action',
  'review_with_tonborg', 'get_agent_quality_gate', 'get_project_team', 'recommend_next_workflow_steps', 'find_agents',
  'capture_session_knowledge', 'record_decision_trace', 'record_workflow_transition_observation',
  'checkpoint_project_agent_memory', 'record_project_agent_task_activity', 'record_project_agent_executor_actual',
  'record_project_agent_task_outcome'
]);
// Bare: a value that is not a current task token only leaves the call without a session.
const TOKEN_FIELD = Object.freeze({ type: 'string' });

// A tool definition as Agents see it: an attributed tool lists the token.
export function withSessionAttribution(definition) {
  return ATTRIBUTED_TOOLS.has(definition.name) ? { ...definition, inputSchema: { ...definition.inputSchema,
    properties: { ...definition.inputSchema.properties, taskContextToken: TOKEN_FIELD } } } : definition;
}

// The input a tool itself receives.
export function withoutSessionAttribution(name, input) {
  if (!ATTRIBUTED_TOOLS.has(name) || !input || typeof input !== 'object' || !Object.hasOwn(input, 'taskContextToken')) return input;
  const { taskContextToken: _attribution, ...rest } = input;
  return rest;
}
const GUIDANCE = 'FULI is off for this session, so nothing was read, injected, recorded or started. Do not call FULI tools for this session or add an agent_receipt; only the person can turn it on (/fuli start).';
// The refusals that are not the person turning FULI off here.
const REASON_GUIDANCE = Object.freeze({
  session_unattributed: 'FULI could not tell which session this call comes from while a session of this client has FULI off, so nothing was read or started. Calls that carry the current taskContextToken of this session are served; do not describe this as the person stopping FULI here.',
  // Every prompt, a "continue" included, begins a new task; only a session's
  // current task can be checkpointed (store_task_contexts.py).
  task_token_not_current: 'This call\'s taskContextToken is not the current task of its session (each new prompt, a "continue" included, begins a new task with a new token; a token of another client or one FULI never issued looks the same), and a session of this client has FULI off, so nothing was read, recorded or started. Retry with the taskContextToken from this turn\'s FULI context. Do not try to checkpoint or record the earlier task: a task that is no longer current cannot be checkpointed. Do not describe this as the person stopping FULI here.',
  policy_unavailable: 'FULI could not read what it needs to decide whether this session may be served (its session state or this call\'s task), so nothing was read, recorded or started. This is not the person stopping FULI; a later call may be served.'
});

// Whether a call must first ask which sessions it speaks for: a tool that is
// not open while FULI may be off for some session. Otherwise it runs as before.
export function needsSessionFuliCheck(app, name) {
  return !OPEN_TOOLS.has(name) && sessionsMayBeOff(app);
}

// The refusal a tool returns instead of running, or null. The session is the
// one the call's task token was bound to, the host session of the call or a
// session it names (session-layer-decision.js), never one a model can choose
// to allow it.
export async function sessionFuliRefusal(app, input = {}) {
  // The client the call's process was started for decides, whatever the payload names or omits.
  const sourceApplication = activeAgentHostClient() ?? input?.sourceApplication ?? 'other';
  const decision = sessionUseDecision(app, { sourceApplication,
    sessionId: input?.sessionId ?? input?.sourceSessionId ?? null, ...await tokenBinding(app, input, sourceApplication) });
  return decision.allowed ? null : { status: SESSION_FULI_OFF, reason: decision.reason,
    notice: captureNotice(decision.reason, decision.since), guidance: REASON_GUIDANCE[decision.reason] ?? GUIDANCE };
}

// The session the call's task token is bound to or, for a token that binds it
// to none, why: it is not its session's current task, or the registry could
// not answer. That leaves the decision to the other identities; the tool
// itself then refuses the token. A value that cannot be a token says nothing.
async function tokenBinding(app, input, sourceApplication) {
  const token = input?.taskContextToken;
  if (typeof token !== 'string' || !token || token.length > 256 || !app.taskContextRegistry) return {};
  try {
    const boundSessionId = await app.taskContextRegistry.currentTaskSession(token, sourceApplication);
    return boundSessionId ? { boundSessionId } : { tokenUnresolved: 'task_token_not_current' };
  } catch {
    return { tokenUnresolved: 'policy_unavailable' };
  }
}
