import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { firstField, listDirectory } from '../session-log.js';

// Wakes Claude Code headlessly. Resuming forks the session, so an open window is
// never written concurrently while the answer still has that conversation's context.
export const claudeCodeWake = Object.freeze({
  id: 'claude_code',

  judgmentArgs({ quality }) {
    return ['-p', '--output-format', 'stream-json', '--verbose', '--safe-mode',
      '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--setting-sources', '', '--no-session-persistence', '--permission-mode', 'dontAsk',
      '--effort', quality === 'economy' ? 'low' : quality === 'balanced' ? 'medium' : 'high'];
  },

  resolveCommand({ env, which, platform }) {
    return env.FULI_CLAUDE_BIN || which('claude', platform);
  },

  args({ sessionId }) {
    return ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk',
      ...(sessionId ? ['--resume', sessionId, '--fork-session'] : [])];
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
  readEvent(event, state) {
    if (event.type !== 'result') return;
    state.body = event.result ?? '';
    state.failed ||= Boolean(event.is_error);
  },
});
