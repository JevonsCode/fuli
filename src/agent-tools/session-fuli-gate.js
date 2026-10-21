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
// Tools an Agent calls without a task of their own (entry, recall, team and
// judgment reads). They take the current taskContextToken only to say which
// session they are for: without it, a call is refused while any session of
// its client is off, since no host session shows the current one (option Y,
// #251). The token is used here and never reaches the tool.
const ATTRIBUTED_TOOLS = new Set([
  'get_collaboration_preferences', 'get_user_taste_skill', 'search_current_project_knowledge', 'search_knowledge_graph',
  'search_connected_knowledge', 'list_project_agents', 'get_project_agent_context', 'get_project_agent_memory',
  'list_preference_conflicts', 'resolve_deferred_preference_conflict', 'request_agent_attention', 'assess_agent_action',
  'review_with_tonborg', 'get_agent_quality_gate', 'get_project_team', 'recommend_next_workflow_steps', 'find_agents'
]);
// Bare: a value the registry does not know only leaves the call unattributed.
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
const UNATTRIBUTED_GUIDANCE = 'FULI could not tell which session this call comes from while a session of this client has FULI off, so nothing was read or started. Calls that carry the current taskContextToken of this session are served; do not describe this as the person stopping FULI here.';

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
    sessionId: input?.sessionId ?? input?.sourceSessionId ?? null, boundSessionId: await boundSession(app, input, sourceApplication) });
  return decision.allowed ? null : { status: SESSION_FULI_OFF, reason: decision.reason,
    notice: captureNotice(decision.reason, decision.since),
    guidance: decision.reason === 'session_unattributed' ? UNATTRIBUTED_GUIDANCE : GUIDANCE };
}

// A token that does not resolve leaves the decision to the other identities;
// the tool itself then refuses the token.
async function boundSession(app, input, sourceApplication) {
  const token = input?.taskContextToken;
  if (typeof token !== 'string' || !token || token.length > 256 || !app.taskContextRegistry) return null;
  try {
    return (await app.taskContextRegistry.context(token, sourceApplication)).sessionId ?? null;
  } catch {
    return null;
  }
}
