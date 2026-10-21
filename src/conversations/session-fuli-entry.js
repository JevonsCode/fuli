import { stat } from 'node:fs/promises';
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
  session_not_started: 'FULI is not on for this session, by the default it started under.',
  session_start_unsaved: 'FULI could not save how this session started, so it stays off.'
});
const OFF_GUIDANCE = ' No FULI memory, preferences or task token this turn. Do not call FULI tools or add an agent_receipt; answer without FULI. Only the person can turn it on (/fuli start). What was already in this conversation stays in your context.';
const UNKNOWN_CONTEXT = 'FULI could not confirm it is on for this session, so it supplied nothing.';

function sessionFuliCommand(prompt) {
  return COMMAND.exec(typeof prompt === 'string' ? prompt : '')?.[1].toLowerCase() ?? null;
}

// The answer to the person's command line, or null when the prompt is not one.
export async function sessionFuliCommandResult(application, { sessionId, sourceApplication, prompt, projectPath = null,
  transcriptPath = null }) {
  const action = sessionFuliCommand(prompt);
  if (!action) return null;
  await keepStartingDefault(application, { sessionId, sourceApplication, transcriptPath });
  return switchSessionFuli(application, { sessionId, sourceApplication, action, projectPath });
}

// The refusal of a task entry for a session FULI does not serve, or null.
export async function sessionFuliEntryRefusal(application, { sessionId, sourceApplication, transcriptPath = null }) {
  const kept = await keepStartingDefault(application, { sessionId, sourceApplication, transcriptPath });
  const decision = sessionUseDecision(application, { sessionId, sourceApplication });
  if (!decision.allowed) return decision;
  return kept ? null : { allowed: false, reason: 'session_start_unsaved', layer: 'session' };
}

// The model's only FULI context for a turn FULI is off for.
export function sessionFuliOffContext(refusal) {
  return (OFF_CONTEXT[refusal.reason] ?? UNKNOWN_CONTEXT) + OFF_GUIDANCE;
}

// A session's first entry keeps the default it started under, so a later
// change of the default leaves this window alone. False when neither that nor
// keeping the session off could be saved: its entry is refused this time.
async function keepStartingDefault(application, { sessionId, sourceApplication, transcriptPath }) {
  try {
    application.pinSessionFuliDefault?.(sessionId, sourceApplication, await sessionStart(transcriptPath));
    return true;
  } catch {
    return false;
  }
}

// When the host session began, from the transcript the host keeps for it: a
// session whose transcript does not exist yet is new. Unknown (no path, no
// birth time) is null, which a later default cannot turn on.
async function sessionStart(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  try {
    const { birthtimeMs } = await stat(transcriptPath);
    return birthtimeMs > 0 ? { at: birthtimeMs } : null;
  } catch (error) {
    return error?.code === 'ENOENT' ? { isNew: true } : null;
  }
}
