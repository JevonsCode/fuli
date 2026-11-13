import { isFuliProcessSession } from '../mcp/session-id.js';
import { normalisedClient } from '../agents/source-applications.js';

// Which client sessions an open task runs in, for 今天's 正在干活: only what the
// task's own records name. Each progress event keeps the client and session
// that reported it, and the task keeps the session it came from. Nothing is
// guessed: a task that names no client has no sessions. One per client, its
// latest session, so the console shows one mark per client. A client whose
// only session ID is one FULI gave its own MCP process is still listed, with
// no session: the client is known, the conversation to open is not. Read from
// the task as already listed, so it costs no further read.
const TASK_SESSION_LIMIT = 3;
const FINISHED = new Set(['completed', 'failed', 'cancelled']);

/** At most three `{ client, sessionId | null }`, one per client: the latest reporters first, then the session the task came from. */
export function taskSessions(task) {
  if (FINISHED.has(task.status)) return [];
  const events = task.events ?? [];
  const sessions = new Map();
  const complete = () => sessions.size === TASK_SESSION_LIMIT
    && [...sessions.values()].every(session => session.sessionId);
  const record = (reported, sessionId) => {
    const client = normalisedClient(reported);
    // The console shows nothing for `other`, so it takes no place here either.
    if (!client || client === 'other') return;
    // A session ID FULI gave its own MCP process names no conversation the person could open.
    const opens = sessionId && !isFuliProcessSession(sessionId) ? sessionId : null;
    const listed = sessions.get(client);
    if (listed) listed.sessionId ??= opens;
    else if (sessions.size < TASK_SESSION_LIMIT) sessions.set(client, { client, sessionId: opens });
  };
  // Newest first, without copying the list: once three clients each name a
  // session, an older event can only repeat a client already listed.
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || typeof event !== 'object') continue;
    record(event.sourceApplication, event.sourceSessionId);
    if (complete()) break;
  }
  record(task.sourceApplication, task.sourceSessionId);
  return [...sessions.values()];
}
