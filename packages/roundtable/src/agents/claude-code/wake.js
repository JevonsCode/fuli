import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { firstField, listDirectory } from '../session-log.js';

// Wakes Claude Code headlessly. Resuming forks the session, so an open window is
// never written concurrently while the answer still has that conversation's context.
export const claudeCodeWake = Object.freeze({
  id: 'claude_code',

  resolveCommand({ env, which, platform }) {
    return env.FULI_CLAUDE_BIN || which('claude', platform);
  },

  // Claude Code reports its session only after the prompt hook has run, so a
  // delegated wake names the (forked) session up front and binds it first.
  plansSession: true,

  // readOnly (a group discussion turn) runs in plan mode: Claude Code reads
  // and answers but edits no file and runs no command.
  args({ sessionId, plannedSessionId = null, readOnly = false }) {
    return ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', readOnly ? 'plan' : 'dontAsk',
      ...(sessionId ? ['--resume', sessionId, '--fork-session'] : []),
      ...(plannedSessionId ? ['--session-id', plannedSessionId] : [])];
  },

  // A session resumes only from the directory it started in.
  sessionDirectory(sessionId, { home }) {
    const root = join(home, '.claude', 'projects');
    for (const project of listDirectory(root)) {
      const file = join(root, project, `${sessionId}.jsonl`);
      if (existsSync(file)) return firstField(file, (line) => line.cwd);
    }
    return null;
  },

  // stream-json ends with one `result` event carrying the final answer.
  initialState: () => ({ body: '', completed: true, failed: false }),
  nativeSessionId: event => event.type === 'system' && event.subtype === 'init' ? event.session_id : null,
  readEvent(event, state) {
    if (event.type !== 'result') return;
    state.body = event.result ?? '';
    state.failed ||= Boolean(event.is_error);
  },
});
