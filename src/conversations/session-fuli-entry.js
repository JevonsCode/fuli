import { switchSessionFuli } from '../graphiti/session-fuli-switch.js';
import { sessionUseDecision } from '../graphiti/session-layer-decision.js';

// What every client's prompt hook does first (rec#5 C3b). A prompt that is
// exactly the person's FULI session command (/fuli stop, fuli stop or $fuli
// stop; start, restart and status alike) is applied to the hook's own host
// session and answered there, so the model never handles it; each client's
// hook shows the answer in its own format. Any other prompt of a session FULI
// is off for gets no task entry: no memory, preferences or recall, and no task
// token to record or collaborate with. Only a line the person typed changes
// the switch; a model's sentence or tool call never does.

const COMMAND = /^\s*[/$]?fuli\s+(start|stop|restart|status)\s*$/i;
const OFF_CONTEXT = Object.freeze({
  session_stopped: 'FULI is stopped for this session by the person.',
  session_not_started: 'FULI is not on for this session: new sessions start with it off.'
});
const OFF_GUIDANCE = ' No FULI memory, preferences or task token this turn. Do not call FULI tools or add an agent_receipt; answer without FULI. Only the person can turn it on (/fuli start). What was already in this conversation stays in your context.';
const UNKNOWN_CONTEXT = 'FULI could not confirm it is on for this session, so it supplied nothing.';

function sessionFuliCommand(prompt) {
  return COMMAND.exec(typeof prompt === 'string' ? prompt : '')?.[1].toLowerCase() ?? null;
}

// The answer to the person's command line, or null when the prompt is not one.
export async function sessionFuliCommandResult(application, { sessionId, sourceApplication, prompt, projectPath = null }) {
  const action = sessionFuliCommand(prompt);
  if (!action) return null;
  keepStartingDefault(application, sessionId, sourceApplication);
  return switchSessionFuli(application, { sessionId, sourceApplication, action, projectPath });
}

// The refusal of a task entry for a session FULI does not serve, or null.
export function sessionFuliEntryRefusal(application, { sessionId, sourceApplication }) {
  keepStartingDefault(application, sessionId, sourceApplication);
  const decision = sessionUseDecision(application, { sessionId, sourceApplication });
  return decision.allowed ? null : decision;
}

// The model's only FULI context for a turn FULI is off for.
export function sessionFuliOffContext(refusal) {
  return (OFF_CONTEXT[refusal.reason] ?? UNKNOWN_CONTEXT) + OFF_GUIDANCE;
}

// A session's first entry keeps the default it started under, so a later
// change of the default leaves this window alone. Best effort: without the
// pin the session follows the default, and an unreadable default refuses.
function keepStartingDefault(application, sessionId, sourceApplication) {
  try {
    application.pinSessionFuliDefault?.(sessionId, sourceApplication);
  } catch { /* see above */ }
}
