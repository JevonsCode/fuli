import { isFuliProcessSession } from '../mcp/session-id.js';

// Which client sessions an open task runs in, for 今天's 正在干活: only what the
// task's own records name. Each progress event keeps the client and session
// that reported it, and the task keeps the session it came from. Nothing is
// guessed: a task with neither has no sessions. One per client, its latest
// session, so the console shows one mark per client. Read from the task as
// already listed, so it costs no further read.
const TASK_SESSION_LIMIT = 3;
const FINISHED = new Set(['completed', 'failed', 'cancelled']);

/** At most three `{ client, sessionId }`, one per client: the latest reporters first, then the session the task came from. */
export function taskSessions(task) {
  if (FINISHED.has(task.status)) return [];
  const named = [...(task.events ?? [])].reverse()
    .concat({ sourceApplication: task.sourceApplication, sourceSessionId: task.sourceSessionId });
  const sessions = new Map();
  for (const { sourceApplication: client, sourceSessionId: sessionId } of named) {
    // A session ID FULI gave its own MCP process names no conversation the person could open.
    if (!client || !sessionId || isFuliProcessSession(sessionId)) continue;
    if (!sessions.has(client)) sessions.set(client, { client, sessionId });
    if (sessions.size === TASK_SESSION_LIMIT) break;
  }
  return [...sessions.values()];
}
