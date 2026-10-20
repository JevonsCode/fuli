import { sessionsMayBeOff, sessionUseDecision } from '../graphiti/session-layer-decision.js';
import { captureNotice } from '../graphiti/capture-notice.js';

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
  const decision = sessionUseDecision(app, { sourceApplication: input?.sourceApplication ?? 'other',
    sessionId: input?.sessionId ?? input?.sourceSessionId ?? null, boundSessionId: await boundSession(app, input) });
  return decision.allowed ? null : { status: SESSION_FULI_OFF, reason: decision.reason,
    notice: captureNotice(decision.reason, decision.since),
    guidance: decision.reason === 'session_unattributed' ? UNATTRIBUTED_GUIDANCE : GUIDANCE };
}

// A token that does not resolve leaves the decision to the other identities;
// the tool itself then refuses the token.
async function boundSession(app, input) {
  if (typeof input?.taskContextToken !== 'string' || !app.taskContextRegistry) return null;
  try {
    return (await app.taskContextRegistry.context(input.taskContextToken, input.sourceApplication ?? 'other')).sessionId ?? null;
  } catch {
    return null;
  }
}
