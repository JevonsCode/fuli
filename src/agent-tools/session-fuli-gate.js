import { sessionsMayBeOff, sessionsMayBeWithoutCapture, sessionUseDecision } from '../graphiti/session-layer-decision.js';
import { captureNotice } from '../graphiti/capture-notice.js';
import { activeAgentHostClient, runWithTaskBoundSession } from '../app/agent-request-context.js';

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
// Every other tool is attributed unless its own schema names a task token
// (rec#11 D-62): entry, recall, team and judgment reads an Agent calls without
// a task of its own and the records a task writes as it goes or closes alike.
// It takes the current taskContextToken only to say which session it is for:
// without it, a call is refused while any session of its client is off, since
// no host session shows the current one (option Y, #251). The token is used
// here and never reaches the tool. A tool that names a task token keeps its
// own field and receives it. There is no list to keep: a new tool is
// attributed unless it is open or names its own token.
const OWN_TOKEN_FIELDS = Object.freeze(['taskContextToken', 'task_context_token']);
// Bare: a value that is not a current task token only leaves the call without a session.
const TOKEN_FIELD = Object.freeze({ type: 'string' });

// The session gate over the Agent tool definitions: what Agents see of them,
// the input each tool itself receives and how a call runs.
export function createSessionGate(definitions) {
  const attributed = new Set(definitions.filter(({ name, inputSchema }) => !OPEN_TOOLS.has(name)
    && !OWN_TOKEN_FIELDS.some(field => Object.hasOwn(inputSchema.properties ?? {}, field))).map(({ name }) => name));
  return Object.freeze({
    // An attributed tool lists the token.
    definitions: definitions.map(definition => attributed.has(definition.name) ? { ...definition, inputSchema: {
      ...definition.inputSchema, properties: { ...definition.inputSchema.properties, taskContextToken: TOKEN_FIELD } } }
      : definition),
    // The input a tool itself receives.
    toolInput(name, input) {
      if (!attributed.has(name) || !input || typeof input !== 'object' || !Object.hasOwn(input, 'taskContextToken')) return input;
      const { taskContextToken: _attribution, ...rest } = input;
      return rest;
    },
    run: (app, name, input, dispatch) => runSessionGated(app, { name, attributed: attributed.has(name) }, input, dispatch)
  });
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

// Runs an Agent's tool call (inside its request context) through the session
// layer. A tool that is not open is refused while FULI may be off for some
// session; otherwise it runs as before. A current task token an attributed
// tool carries binds the rest of the call to the token's session, so the
// capture decisions of its writes count that session as their task's, with
// its pause and stop, while another session of the client records nothing.
// A call that needs neither runs as before, synchronously.
function runSessionGated(app, { name, attributed }, input, dispatch) {
  const checked = !OPEN_TOOLS.has(name) && sessionsMayBeOff(app);
  if (!checked && !attributed) return dispatch();
  // The client the call's process was started for decides, whatever the payload names or omits.
  const sourceApplication = activeAgentHostClient() ?? input?.sourceApplication ?? 'other';
  if (!checked && !sessionsMayBeWithoutCapture(app, sourceApplication)) return dispatch();
  return gatedCall(app, input, dispatch, { attributed, checked, sourceApplication });
}

async function gatedCall(app, input, dispatch, { attributed, checked, sourceApplication }) {
  const binding = await tokenBinding(app, input, sourceApplication);
  const refusal = checked ? sessionFuliRefusal(app, input, sourceApplication, binding) : null;
  if (refusal) return refusal;
  return attributed && binding.boundSessionId
    ? runWithTaskBoundSession(binding.boundSessionId, dispatch) : dispatch();
}

// The refusal a tool returns instead of running, or null. The session is the
// one the call's task token was bound to, the host session of the call or a
// session it names (session-layer-decision.js), never one a model can choose
// to allow it.
function sessionFuliRefusal(app, input, sourceApplication, binding) {
  const decision = sessionUseDecision(app, { sourceApplication,
    sessionId: input?.sessionId ?? input?.sourceSessionId ?? null, ...binding });
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
