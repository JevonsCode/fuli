import { isFuliProcessSession } from '../mcp/session-id.js';

// A block belongs to the client session that reported it. When that same
// session goes on (the person replies there, or it records a checkpoint), the
// Provider ends the block and records why. Only a session the client named
// counts: an identity FULI gave its own process names no conversation.
// It is a write the session caused, so it runs only when capture allows that
// session's writes (capture-decision.js); a person who turned recording off
// clears a block by hand. Best effort: task entry and checkpoints never fail
// because of it.
export async function clearSessionTaskBlockers(application, { sourceApplication, sessionIds, cause, captureAllowed }) {
  const sessions = [...new Set(sessionIds)].filter(namedSession);
  if (!captureAllowed || !sessions.length || !application.personal?.clearSessionTaskBlockers) return [];
  const cleared = [];
  for (const sessionId of sessions) {
    try {
      const result = await application.personal.clearSessionTaskBlockers({
        personal_space_id: application.config.personal.spaceId,
        source_application: sourceApplication, source_session_id: sessionId, cause
      });
      cleared.push(...(result?.cleared_task_ids ?? []));
    } catch { /* The block stays visible; the next progress in that session clears it. */ }
  }
  return cleared;
}

// An Agent recorded work in its project from this session: a block of one of
// its tasks reported in another session may have been solved here, or not.
// The Provider keeps the block and marks it probably resolved, for the person
// to confirm; nothing is read from the conversation's text. Same capture
// decision and best effort as the clear above.
export async function noteBlockerProgress(application, { sourceApplication, sessionId, personalProjectId, agentId, captureAllowed }) {
  if (!captureAllowed || !namedSession(sessionId) || !personalProjectId || !agentId
    || !application.personal?.noteBlockerProgress) return [];
  try {
    const result = await application.personal.noteBlockerProgress({
      personal_space_id: application.config.personal.spaceId, personal_project_id: personalProjectId,
      agent_id: agentId, source_application: sourceApplication, source_session_id: sessionId
    });
    return result?.hinted_task_ids ?? [];
  } catch {
    return []; // The block stays as reported; the person can still mark it cleared.
  }
}

function namedSession(id) {
  return typeof id === 'string' && Boolean(id) && !isFuliProcessSession(id);
}
