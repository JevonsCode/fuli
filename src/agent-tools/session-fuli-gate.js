import { sessionsMayBeOff, sessionUseDecision } from '../graphiti/session-layer-decision.js';
import { captureNotice } from '../graphiti/capture-notice.js';

// Tools FULI does not serve to a session it is off for (rec#5 C3b): task entry
// and preference recovery, which inject memory, and the tools that start
// collaboration (workers, loans, assignments, runs, schedules, role work,
// Tonborg, employees and other Agents). Reads the person asks for and writes,
// which the capture decision already refuses, are not listed. The session is
// the one the call's task token was bound to, the host session of the call or
// a session it names (session-layer-decision.js), never one a model can
// choose to allow it.
const SERVED_TOOLS = new Set([
  'begin_task_context', 'get_collaboration_preferences', 'read_task_preferences', 'get_user_taste_skill',
  'plan_agent_collaboration', 'request_agent_loan', 'coordinate_project_agent_task', 'submit_project_agent_task',
  'create_project_agent_assignment', 'replace_project_agent_assignment', 'control_project_agent_task_run',
  'manage_project_agent_schedule', 'resume_agent_conversation', 'review_with_tonborg', 'assess_agent_action',
  'assess_task_completion', 'role_work', 'call_employee_tool', 'recruit_employee', 'request_agent_attention',
  'message_agent', 'agent_chat', 'reply_agent_message'
]);
export const SESSION_FULI_OFF = 'fuli_off';
const GUIDANCE = 'FULI is off for this session, so nothing was read, injected, recorded or started. Do not call FULI tools for this session or add an agent_receipt; only the person can turn it on (/fuli start).';

// Whether a call must first ask which sessions it speaks for: a served tool
// while FULI may be off for some session. Otherwise it runs as before.
export function needsSessionFuliCheck(app, name) {
  return SERVED_TOOLS.has(name) && sessionsMayBeOff(app);
}

// The refusal a served tool returns instead of running, or null.
export async function sessionFuliRefusal(app, input = {}) {
  const decision = sessionUseDecision(app, { sourceApplication: input?.sourceApplication ?? 'other',
    sessionId: input?.sessionId ?? input?.sourceSessionId ?? null, boundSessionId: await boundSession(app, input) });
  return decision.allowed ? null : { status: SESSION_FULI_OFF, reason: decision.reason,
    notice: captureNotice(decision.reason, decision.since), guidance: GUIDANCE };
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
